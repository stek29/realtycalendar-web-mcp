// Confirm tokens (spec §1 "Writes"): an HMAC over the plan and an expiry. Stateless; crypto.subtle only.

export const TOKEN_TTL_SEC = 15 * 60

/** JSON with object keys sorted, so equal plans give equal strings. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const encoder = new TextEncoder()

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

function fromB64url(s: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return undefined
  }
}

const hmacKey = (key: Uint8Array, usage: 'sign' | 'verify') =>
  crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])

const message = (exp: number, plan: unknown) => encoder.encode(`${exp}\n${canonicalJson(plan)}`)

/** token = base64url(exp) "." base64url(HMAC-SHA256(key, exp "\n" canonical_json(plan))); exp in seconds. */
export async function signPlan(key: Uint8Array, plan: unknown, now: Date): Promise<string> {
  const exp = Math.floor(now.getTime() / 1000) + TOKEN_TTL_SEC
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(key, 'sign'), message(exp, plan)))
  return `${b64url(encoder.encode(String(exp)))}.${b64url(mac)}`
}

/** True if the token was signed for exactly this plan with this key and hasn't expired. */
export async function verifyPlan(key: Uint8Array, token: string, plan: unknown, now: Date): Promise<boolean> {
  const [expPart, macPart, ...rest] = token.split('.')
  if (!expPart || !macPart || rest.length) return false
  const expBytes = fromB64url(expPart)
  const mac = fromB64url(macPart)
  if (!expBytes || !mac) return false
  const exp = Number(new TextDecoder().decode(expBytes))
  if (!Number.isInteger(exp) || exp < now.getTime() / 1000) return false
  return crypto.subtle.verify('HMAC', await hmacKey(key, 'verify'), mac, message(exp, plan))
}
