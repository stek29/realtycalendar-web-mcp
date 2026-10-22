// Prints what a client sees: the server instructions and tools/list, for RC_ACCESS (default full) and
// RC_SITE_BOOKINGS from the environment. `npm run tools`; the exact text behind spec §1 and §2.
import { z } from 'zod'
import { accessAllows, parseConfig } from '../src/config.js'
import { instructions } from '../src/mcp/instructions.js'
import { TOOLS } from '../src/mcp/server.js'

const config = parseConfig({ RC_ACCESS: 'full', ...process.env })
const tools = TOOLS.filter((t) => accessAllows(config.access, t.level)).map((t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  annotations: t.annotations,
  inputSchema: z.toJSONSchema(t.input),
  outputSchema: z.toJSONSchema(t.output),
}))
console.log(JSON.stringify({ instructions: instructions('2054-10-22', config), tools }, null, 2))
