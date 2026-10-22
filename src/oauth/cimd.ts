// Client registration: CIMD only, allowlisted URLs (D52). The document is fetched and its redirect URIs checked.

export interface ClientInfo {
  client_id: string
  client_name: string
  redirect_uris: string[]
}

/**
 * The allowlist, with the documents as fetched 2054-10-22. The copy is used when a fetch fails (D55): claude.ai and
 * chatgpt.com sit behind Cloudflare, which may challenge requests from a datacenter IP.
 */
export const KNOWN_CLIENTS: Readonly<Record<string, ClientInfo>> = Object.fromEntries(
  [
    ['https://claude.ai/oauth/mcp-oauth-client-metadata', 'Claude', ['https://claude.ai/api/mcp/auth_callback']],
    [
      'https://claude.ai/oauth/claude-code-client-metadata',
      'Claude Code',
      ['http://localhost/callback', 'http://127.0.0.1/callback'],
    ],
    ['https://chatgpt.com/oauth/client.json', 'ChatGPT', ['https://chatgpt.com/connector_platform_oauth_redirect']],
  ].map(([id, name, uris]) => [id, { client_id: id, client_name: name, redirect_uris: uris }] as const),
) as Record<string, ClientInfo>

export const ALLOWED_CLIENTS: readonly string[] = Object.keys(KNOWN_CLIENTS)

const CACHE_MS = 3600_000
const FETCH_TIMEOUT_MS = 5000

export interface ClientRegistry {
  /** The client's metadata, or undefined when it isn't allowed or its document can't be fetched or is invalid. */
  get(clientId: string): Promise<ClientInfo | undefined>
}

export function cimdRegistry(opts: {
  fetch?: typeof fetch
  now?: () => number
  allowed?: readonly string[]
  /** Called when the bundled copy stands in for a document that couldn't be fetched. */
  onFallback?: (clientId: string, reason: string) => void
}): ClientRegistry {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
  const now = opts.now ?? Date.now
  const allowed = opts.allowed ?? ALLOWED_CLIENTS
  const cache = new Map<string, { info: ClientInfo; expires: number }>()
  return {
    async get(clientId) {
      if (!allowed.includes(clientId)) return undefined
      const hit = cache.get(clientId)
      if (hit && hit.expires > now()) return hit.info
      // A stale document, then the bundled copy, is better than locking users out when the client's host is down
      // or blocks us. A document that was fetched but is wrong is refused.
      const fallback = (reason: string) => {
        const info = hit?.info ?? KNOWN_CLIENTS[clientId]
        if (info) opts.onFallback?.(clientId, reason)
        return info
      }
      let doc: unknown
      try {
        const res = await doFetch(clientId, {
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        if (!res.ok) return fallback(`HTTP ${res.status}`)
        doc = await res.json()
      } catch (e) {
        return fallback(String(e))
      }
      const info = parseDocument(clientId, doc)
      if (info) cache.set(clientId, { info, expires: now() + CACHE_MS })
      return info
    },
  }
}

function parseDocument(clientId: string, doc: unknown): ClientInfo | undefined {
  if (typeof doc !== 'object' || doc === null) return undefined
  const d = doc as Record<string, unknown>
  if (d.client_id !== clientId) return undefined
  if (!Array.isArray(d.redirect_uris) || !d.redirect_uris.every((u) => typeof u === 'string')) return undefined
  const name = typeof d.client_name === 'string' && d.client_name ? d.client_name : new URL(clientId).host
  return { client_id: clientId, client_name: name, redirect_uris: d.redirect_uris as string[] }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Exact match, except that an http loopback redirect URI matches on any port (RFC 8252 §7.3; Claude Code needs it for
 * `localhost` too).
 */
export function redirectAllowed(client: ClientInfo, redirectUri: string): boolean {
  if (client.redirect_uris.includes(redirectUri)) return true
  let uri: URL
  try {
    uri = new URL(redirectUri)
  } catch {
    return false
  }
  if (uri.protocol !== 'http:' || !LOOPBACK.has(uri.hostname)) return false
  return client.redirect_uris.some((registered) => {
    try {
      const r = new URL(registered)
      return (
        r.protocol === 'http:' &&
        r.hostname === uri.hostname &&
        r.pathname === uri.pathname &&
        r.search === uri.search &&
        r.port === ''
      )
    } catch {
      return false
    }
  })
}
