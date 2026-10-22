import { z } from 'zod'
import type { ToolAnnotations } from '@modelcontextprotocol/server'
import type { AuditEntry } from '../../audit.js'
import type { Access } from '../../config.js'
import type { Context } from '../../context.js'
import { signPlan, verifyPlan } from '../../domain/confirm.js'
import { ToolError } from '../../domain/errors.js'
import { WriteOutput } from './shared.js'

export interface ToolDef<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  name: string
  level: Access
  title: string
  description: string
  input: I
  output: O
  annotations: ToolAnnotations
  handler: (ctx: Context, args: z.infer<I>) => Promise<z.infer<O>>
}

export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def
}

export const READ_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: true }

/**
 * Every write tool is destructive (D34): Claude then always asks the user before the call, which is the approval of
 * the write (D35). Creates too: they leave a guest record that can't be deleted and block a room.
 */
export const WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
}

export interface WritePreview {
  /** What the confirm token signs: target ids, the field values to write, the booking state. Never raw arguments. */
  plan: unknown
  /** What the model sees (WriteOutput's preview fields). */
  view: Record<string, unknown> & { summary: string }
  /** No token: the write can't or shouldn't happen (DUPLICATE, will_fail). */
  blocked: boolean
  /** For the audit entry: the booking (null for a create), the RC fields written, the GET before the write. */
  audit: { booking_id: number | null; fields: string[]; before?: unknown }
}

export interface WriteToolDef<I extends z.ZodObject, P extends WritePreview> {
  name: string
  level: Access
  title: string
  /** What the write does and when to use it; shared by the preview tool and the write tool. */
  description: string
  input: I
  /** Booking id whose confirms are serialised (update, cancel, delete). */
  lockId?: (args: z.infer<I>) => number
  /** Builds the plan from fresh RC data; no side effects. */
  preview: (ctx: Context, args: z.infer<I>) => Promise<P>
  /** Runs only after the token matched a fresh preview; returns WriteOutput's result fields. */
  commit: (ctx: Context, args: z.infer<I>, preview: P) => Promise<Record<string, unknown> & { summary: string }>
}

/**
 * A write as two tools (D33): `preview_<name>` (read-only) builds the plan and signs it; `<name>` takes the same
 * arguments plus the required confirm_token, rebuilds the plan from fresh data, checks the token (mismatch or
 * expired → PREVIEW_STALE with the fresh preview) and commits. The write never previews by itself.
 */
export function defineWriteTool<I extends z.ZodObject, P extends WritePreview>(def: WriteToolDef<I, P>) {
  const previewName = `preview_${def.name}`
  const signed = (p: P) => ({ tool: def.name, ...(p.plan as object) })

  async function show(ctx: Context, p: P) {
    return {
      preview: true,
      ...p.view,
      ...(p.blocked ? {} : { confirm_token: await signPlan(ctx.config.confirmKey, signed(p), ctx.now()) }),
    }
  }

  const previewTool = defineTool({
    name: previewName,
    level: def.level,
    title: `Preview: ${def.title.toLowerCase()}`,
    description:
      `PREVIEW, changes nothing. ${def.description} ` +
      `Returns what ${def.name} would do (before/after, warnings, will_fail) and a confirm_token; no token when it ` +
      `would fail (will_fail) or is a duplicate. Show the preview to the user, then call ${def.name} with the same ` +
      'arguments and the confirm_token.',
    input: def.input,
    output: WriteOutput,
    annotations: READ_ANNOTATIONS,
    async handler(ctx, args) {
      return WriteOutput.parse(await show(ctx, await def.preview(ctx, args as z.infer<I>)))
    },
  })

  const writeTool = defineTool({
    name: def.name,
    level: def.level,
    title: def.title,
    description:
      `WRITE. ${def.description} ` +
      `Always call ${previewName} first and show its preview; then call this with the same arguments and its ` +
      "confirm_token. The user approves in the app's confirmation prompt. Instead of calling this, ask in chat when " +
      'the preview has will_fail, needs a choice, or the user asked to check first.',
    input: def.input.extend({
      confirm_token: z
        .string({ error: `Call ${previewName} first and pass its confirm_token` })
        .min(1, `Call ${previewName} first and pass its confirm_token`)
        .describe(`From ${previewName} with the same arguments; valid 15 minutes`),
    }),
    output: WriteOutput,
    annotations: WRITE_ANNOTATIONS,
    async handler(ctx, all) {
      const { confirm_token, ...rest } = all as z.infer<I> & { confirm_token: string }
      const args = rest as z.infer<I>

      const confirm = async () => {
        const p = await def.preview(ctx, args)
        if (!(await verifyPlan(ctx.config.confirmKey, confirm_token, signed(p), ctx.now()))) {
          throw new ToolError(
            'PREVIEW_STALE',
            'The arguments or the booking changed since the preview, or the preview expired. Nothing was changed.',
            'Show the new preview (included) and ask again',
            { preview: await show(ctx, p) },
          )
        }
        const audit = (bookingId: number | null, result: string) =>
          auditWrite(ctx, { tool: def.name, ...p.audit, booking_id: bookingId, result })
        let done
        try {
          done = WriteOutput.parse({ preview: false, ...(await def.commit(ctx, args, p)) })
        } catch (e) {
          await audit(p.audit.booking_id, e instanceof ToolError ? e.code : 'RC_ERROR')
          // RC refused although the preview didn't foresee it (someone was faster): add what the fresh preview saw.
          if (e instanceof ToolError && e.code === 'OCCUPIED') {
            throw new ToolError(e.code, e.message, e.hint, { ...e.details, conflicts: p.view.conflicts ?? null })
          }
          throw e
        }
        await audit(done.booking?.id ?? p.audit.booking_id, done.note ? 'already_existed' : 'ok')
        return done
      }
      const id = def.lockId?.(args)
      return id == null ? confirm() : ctx.withBookingLock(id, confirm)
    },
  })

  return [previewTool, writeTool] as const
}

/** Writes an audit entry after RC answered. A failing sink is logged, never turned into a tool error: the write happened. */
async function auditWrite(ctx: Context, e: Omit<AuditEntry, 'time' | 'rc_user_id'>): Promise<void> {
  try {
    const rcUserId = (await ctx.catalog()).userId
    await ctx.audit.write({ time: ctx.now().toISOString(), rc_user_id: rcUserId, ...e })
  } catch (err) {
    ctx.log.log('error', 'audit_failed', { tool: e.tool, booking_id: e.booking_id, error: String(err) })
  }
}
