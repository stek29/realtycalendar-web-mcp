// Hosted entrypoint (M4): the HTTP server for Claude and ChatGPT connectors. Logs and audit lines go to stdout.
import { serve } from '@hono/node-server'
import { memoryCache } from '../cache.js'
import { parseConfig } from '../config.js'
import { VERSION } from '../context.js'
import { hostedApp } from '../hosted.js'
import { cimdRegistry } from '../oauth/cimd.js'
import { serverKeys } from '../oauth/keys.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export async function runHttp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const fail = (message: string): never => {
    console.error(message)
    process.exit(1)
  }
  const publicUrl = env.MCP_PUBLIC_URL?.trim().replace(/\/+$/, '')
  if (!publicUrl) fail('MCP_PUBLIC_URL is not set, e.g. https://rc.example.com')
  let url: URL
  try {
    url = new URL(publicUrl!)
  } catch {
    return fail(`MCP_PUBLIC_URL is not a URL: "${publicUrl}"`)
  }
  if (url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) fail('MCP_PUBLIC_URL must be https')
  if (url.pathname !== '/' || url.search) fail('MCP_PUBLIC_URL must be an origin without a path')
  if (!env.MCP_SERVER_KEY) fail('MCP_SERVER_KEY is not set (openssl rand -base64 32)')

  let keys, config
  try {
    keys = await serverKeys(env.MCP_SERVER_KEY!, env.MCP_SERVER_KEY_PREVIOUS)
    config = { ...parseConfig(env), confirmKey: keys.confirmKey }
  } catch (e) {
    return fail((e as Error).message)
  }
  const port = Number(env.PORT || 8080)
  const write = (line: string) => process.stdout.write(line + '\n')
  const app = hostedApp({
    publicUrl: url.origin,
    keys,
    config,
    cache: memoryCache(),
    clients: cimdRegistry({
      onFallback: (client_id, reason) =>
        write(
          JSON.stringify({ time: new Date().toISOString(), level: 'warn', event: 'cimd_fallback', client_id, reason }),
        ),
    }),
    write,
  })
  const server = serve({ fetch: app.fetch, port, hostname: env.HOST || '0.0.0.0' })
  write(
    JSON.stringify({
      time: new Date().toISOString(),
      level: 'info',
      event: 'started',
      version: VERSION,
      port,
      public_url: url.origin,
      max_access: config.access,
      site_bookings: config.siteBookings,
    }),
  )
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
