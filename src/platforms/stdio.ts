// v1 entrypoint: MCP over stdio for Claude Desktop, Claude Code, Codex, Inspector. Logs go to stderr.
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { memoryCache } from '../cache.js'
import { streamAudit } from '../audit.js'
import { parseConfig } from '../config.js'
import { makeContext } from '../context.js'
import { jsonLogger } from '../log.js'
import { createMcpServer } from '../mcp/server.js'

export function runStdio(env: NodeJS.ProcessEnv = process.env): void {
  const token = env.RC_TOKEN?.trim()
  if (!token) {
    console.error('RC_TOKEN is not set. Get a token with `realtycalendar-web-mcp login`.')
    process.exit(1)
  }
  const config = parseConfig(env)
  const log = jsonLogger((line) => process.stderr.write(line + '\n'), [token])
  // stdout is the MCP channel, so audit lines go to stderr with the logs.
  const audit = streamAudit((line) => process.stderr.write(line + '\n'), config.audit)
  const ctx = makeContext(token, config, memoryCache(), { log, audit })
  serveStdio(() => createMcpServer(ctx), { onerror: (e) => log.log('error', 'stdio_error', { error: String(e) }) })
  log.log('info', 'started', { access: config.access })
}
