import type { z } from 'zod'
import type { ToolAnnotations } from '@modelcontextprotocol/server'
import type { Access } from '../../config.js'
import type { Context } from '../../context.js'

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
