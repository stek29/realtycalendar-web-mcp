import { z } from 'zod'
import type { ToolAnnotations } from '@modelcontextprotocol/server'
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

export const WRITE_ANNOTATIONS = {
  create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  change: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
} satisfies Record<string, ToolAnnotations>

export interface WritePreview {
  /** What the confirm token signs: target ids, the field values to write, the booking state. Never raw arguments. */
  plan: unknown
  /** What the model sees (WriteOutput's preview fields). */
  view: Record<string, unknown> & { summary: string }
  /** No token: the write can't or shouldn't happen (DUPLICATE, will_fail). */
  blocked: boolean
}

export interface WriteToolDef<I extends z.ZodObject, P extends WritePreview> {
  name: string
  level: Access
  title: string
  description: string
  input: I
  annotations: ToolAnnotations
  /** Booking id whose confirms are serialised (update, cancel, delete). */
  lockId?: (args: z.infer<I>) => number
  /** Builds the plan from fresh RC data; no side effects. */
  preview: (ctx: Context, args: z.infer<I>) => Promise<P>
  /** Runs only after the token matched a fresh preview; returns WriteOutput's result fields. */
  commit: (ctx: Context, args: z.infer<I>, preview: P) => Promise<Record<string, unknown> & { summary: string }>
}

const confirmTokenInput = z
  .string()
  .optional()
  .describe('Leave out for a preview. Pass the token from the preview only after the user said yes to it')

/**
 * A write tool with preview → confirm (spec §1 Writes). Without confirm_token: preview only. With it: a fresh
 * preview, the token checked against its plan (mismatch or expired → PREVIEW_STALE with that preview), then commit.
 */
export function defineWriteTool<I extends z.ZodObject, P extends WritePreview>(def: WriteToolDef<I, P>) {
  const input = def.input.extend({ confirm_token: confirmTokenInput })
  const signed = (p: P) => ({ tool: def.name, ...(p.plan as object) })

  async function show(ctx: Context, p: P) {
    return {
      preview: true,
      ...p.view,
      ...(p.blocked ? {} : { confirm_token: await signPlan(ctx.config.confirmKey, signed(p), ctx.now()) }),
    }
  }

  return defineTool({
    name: def.name,
    level: def.level,
    title: def.title,
    description: def.description,
    input,
    output: WriteOutput,
    annotations: def.annotations,
    async handler(ctx, all) {
      const { confirm_token, ...rest } = all as z.infer<I> & { confirm_token?: string }
      const args = rest as z.infer<I>
      if (!confirm_token) return WriteOutput.parse(await show(ctx, await def.preview(ctx, args)))

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
        try {
          return WriteOutput.parse({ preview: false, ...(await def.commit(ctx, args, p)) })
        } catch (e) {
          // RC refused although the preview didn't foresee it (someone was faster): add what the fresh preview saw.
          if (e instanceof ToolError && e.code === 'OCCUPIED') {
            throw new ToolError(e.code, e.message, e.hint, { ...e.details, conflicts: p.view.conflicts ?? null })
          }
          throw e
        }
      }
      const id = def.lockId?.(args)
      return id == null ? confirm() : ctx.withBookingLock(id, confirm)
    },
  })
}
