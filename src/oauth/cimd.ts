// Client registration: CIMD only, allowlisted URLs (D52). The document is fetched and its redirect URIs checked.

/** Fetched 2054-10-22. */
export const ALLOWED_CLIENTS: readonly string[] = [
  'https://claude.ai/oauth/mcp-oauth-client-metadata',
  'https://claude.ai/oauth/claude-code-client-metadata',
  'https://chatgpt.com/oauth/client.json',
]

export interface ClientInfo {
  client_id: string
  client_name: string
  redirect_uris: string[]
}

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
      try {
        const res = await doFetch(clientId, {
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        if (!res.ok) return hit?.info
        const info = parseDocument(clientId, await res.json())
        if (info) cache.set(clientId, { info, expires: now() + CACHE_MS })
        return info
      } catch {
        // A stale document is better than locking users out while the client's host has a hiccup.
        return hit?.info
      }
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
