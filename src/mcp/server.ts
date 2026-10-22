import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { accessAllows } from '../config.js'
import { VERSION, type Context } from '../context.js'
import { todayIn } from '../domain/dates.js'
import { ToolError } from '../domain/errors.js'
import { instructions } from './instructions.js'
import type { ToolDef } from './tools/define.js'
import { cancelBooking } from './tools/cancel-booking.js'
import { checkAvailability } from './tools/check-availability.js'
import { createBooking } from './tools/create-booking.js'
import { deleteBooking } from './tools/delete-booking.js'
import { getBooking } from './tools/get-booking.js'
import { listBookings } from './tools/list-bookings.js'
import { listRooms } from './tools/list-rooms.js'
import { updateBooking } from './tools/update-booking.js'

export const TOOLS: ToolDef[] = [
  listRooms,
  checkAvailability,
  listBookings,
  getBooking,
  createBooking,
  updateBooking,
  cancelBooking,
  deleteBooking,
] as unknown as ToolDef[]

/** An MCP server with the tools allowed by ctx.config.access. */
export function createMcpServer(ctx: Context): McpServer {
  const today = todayIn(ctx.now(), ctx.config.timezone)
  const server = new McpServer(
    { name: 'realtycalendar-web-mcp', version: VERSION },
    { instructions: instructions(today, ctx.config.timezone, ctx.config.access), capabilities: { tools: {} } },
  )
  for (const tool of TOOLS) {
    if (!accessAllows(ctx.config.access, tool.level)) continue
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: tool.output,
        annotations: tool.annotations,
      },
      (args: unknown) => runTool(ctx, tool, args),
    )
  }
  return server
}

/** Runs a tool: access check, handler, ToolError → isError result, one log line. Exported for tests. */
export async function runTool(ctx: Context, tool: ToolDef, args: unknown): Promise<CallToolResult> {
  const started = Date.now()
  try {
    // Second guard: a client may call a tool from an older tool list.
    if (!accessAllows(ctx.config.access, tool.level)) {
      throw new ToolError(
        'ACCESS_DENIED',
        `${tool.name} is not available on this connection`,
        "Tell the user this connection can't do it; they can do it in RealtyCalendar",
      )
    }
    const output = await tool.handler(ctx, tool.input.parse(args ?? {}))
    ctx.log.log('info', 'tool', { tool: tool.name, duration_ms: Date.now() - started })
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output }
  } catch (e) {
    const error =
      e instanceof ToolError
        ? e
        : e instanceof z.ZodError
          ? new ToolError('VALIDATION', 'Invalid arguments', undefined, {
              issues: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            })
          : new ToolError('RC_ERROR', 'Internal error', 'Try again; if it repeats, report to the admin')
    const unexpected = !(e instanceof ToolError) && !(e instanceof z.ZodError)
    ctx.log.log(unexpected ? 'error' : 'warn', 'tool_error', {
      tool: tool.name,
      duration_ms: Date.now() - started,
      code: error.code,
      ...(unexpected ? { error: String(e) } : {}),
    })
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(error.toJSON()) }] }
  }
}
