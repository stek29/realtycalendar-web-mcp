// realtycalendar-web-mcp [check]: no subcommand runs the stdio server.
import { parseConfig } from '../config.js'
import { RcClient } from '../upstream/client.js'
import { getInfo } from '../upstream/api.js'
import { ToolError } from '../domain/errors.js'
import { VERSION } from '../context.js'
import { runStdio } from '../platforms/stdio.js'

const USAGE = `realtycalendar-web-mcp ${VERSION}

  realtycalendar-web-mcp          run the MCP server over stdio (needs RC_TOKEN)
  realtycalendar-web-mcp check    check that RC_TOKEN works: user, agency, access level

Environment: RC_TOKEN (required), RC_ACCESS=read|book|edit|full (default read),
RC_TIMEZONE (default Europe/Moscow), RC_CONFIRM_KEY.`

/** GET /v2/info with RC_TOKEN. Returns the exit code. */
export async function check(env: NodeJS.ProcessEnv, out: (s: string) => void = console.log): Promise<number> {
  const token = env.RC_TOKEN?.trim()
  if (!token) {
    out('RC_TOKEN is not set.')
    return 1
  }
  let config
  try {
    config = parseConfig(env)
  } catch (e) {
    out(String((e as Error).message))
    return 1
  }
  try {
    const info = await getInfo(
      new RcClient(token, { baseUrl: config.rcBaseUrl, userAgent: `realtycalendar-web-mcp/${VERSION}` }),
    )
    out(`Token works.`)
    out(`User:   ${info.full_name ?? '—'} (RealtyCalendar role: ${info.role ?? '—'})`)
    out(`Agency: ${info.agency.title} (id ${info.agency.id})`)
    out(`Access: ${config.access} (RC_ACCESS)`)
    return 0
  } catch (e) {
    if (e instanceof ToolError && e.code === 'AUTH') out('Token rejected by RealtyCalendar (401): get a new one.')
    else out(`Check failed: ${e instanceof ToolError ? `${e.code}: ${e.message}` : String(e)}`)
    return 1
  }
}

const [command, ...rest] = process.argv.slice(2)
if (command === undefined) await runStdio()
else if (command === 'check' && rest.length === 0) process.exitCode = await check(process.env)
else if (command === '--version') console.log(VERSION)
else {
  console.error(USAGE)
  process.exitCode = command === '--help' || command === '-h' ? 0 : 1
}
