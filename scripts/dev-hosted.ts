// The hosted server on the fake RC, for trying the OAuth flow and clients locally without real credentials:
//   npx tsx scripts/dev-hosted.ts        → http://localhost:8080/mcp, sign in as test / test
// Env: PORT, RC_ACCESS (default full). A fresh random server key each start: clients reconnect after a restart.
import { serve } from '@hono/node-server'
import { memoryCache } from '../src/cache.js'
import { parseConfig } from '../src/config.js'
import { hostedApp } from '../src/hosted.js'
import { cimdRegistry } from '../src/oauth/cimd.js'
import { serverKeys } from '../src/oauth/keys.js'
import { signInRc } from '../test/fake-rc.js'

const port = Number(process.env.PORT || 8080)
const publicUrl = `http://localhost:${port}`
const keys = await serverKeys(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))
const rc = signInRc({ username: 'test', password: 'test' })
const app = hostedApp({
  publicUrl,
  keys,
  config: { ...parseConfig({ RC_ACCESS: 'full', ...process.env }), confirmKey: keys.confirmKey },
  cache: memoryCache(),
  clients: cimdRegistry({}),
  fetch: rc.fetch,
  write: (line) => process.stdout.write(line + '\n'),
})
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })
console.log(`fake-RC hosted server: ${publicUrl}/mcp (login test / test)`)
