// The persistent server key (D53): JWE keys by kid, and the confirm-token key derived from the current one.

export interface ServerKeys {
  /** Kid of the key new tokens are sealed with. */
  kid: string
  /** Every key that may open a token, by kid (current and previous). */
  jwe: Map<string, Uint8Array>
  /** Replaces RC_CONFIRM_KEY in hosted mode, so every replica verifies the same confirm tokens. */
  confirmKey: Uint8Array
}

const MIN_BYTES = 32

/** `current` and `previous` are base64 or base64url secrets of at least 32 bytes. */
export async function serverKeys(current: string, previous?: string): Promise<ServerKeys> {
  const jwe = new Map<string, Uint8Array>()
  const cur = await derive(current, 'MCP_SERVER_KEY')
  jwe.set(cur.kid, cur.jwe)
  if (previous?.trim()) {
    const prev = await derive(previous, 'MCP_SERVER_KEY_PREVIOUS')
    if (!jwe.has(prev.kid)) jwe.set(prev.kid, prev.jwe)
  }
  return { kid: cur.kid, jwe, confirmKey: cur.confirm }
}

async function derive(secret: string, name: string) {
  const raw = decodeBase64(secret.trim())
  if (!raw || raw.length < MIN_BYTES) {
    throw new Error(`${name} must be base64 of at least ${MIN_BYTES} bytes (openssl rand -base64 32)`)
  }
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits'])
  const hkdf = async (info: string) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: new TextEncoder().encode(info) },
        base,
        256,
      ),
    )
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
  const kid = [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return { kid, jwe: await hkdf('realtycalendar-web-mcp jwe'), confirm: await hkdf('realtycalendar-web-mcp confirm') }
}

function decodeBase64(s: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return undefined
  }
}
