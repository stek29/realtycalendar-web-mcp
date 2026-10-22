// Ids for logs. Letters only: redact() masks digit runs (phones) and e-mails, which a UUID or a hex hash can trip.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'

function letters(bytes: Uint8Array): string {
  return [...bytes].map((b) => ALPHABET[b % 26]).join('')
}

/** One per HTTP request: in every log line of that request, the X-Request-Id response header and RC calls. */
export function newRequestId(): string {
  return letters(crypto.getRandomValues(new Uint8Array(12)))
}

/**
 * A stable pseudonym of the RC login for logs (the login is often an e-mail, which logs never carry). To find a
 * user's lines, compute it for their login.
 */
export async function accountId(username: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(username.trim().toLowerCase()))
  return letters(new Uint8Array(digest).slice(0, 10))
}
