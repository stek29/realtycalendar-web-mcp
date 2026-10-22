// All OAuth state lives in JWE tokens under the server key (architecture.md "Tokens"); nothing is stored.
import { EncryptJWT, jwtDecrypt, type JWTPayload } from 'jose'
import type { Access } from '../config.js'
import type { ServerKeys } from './keys.js'

/** Lifetimes in seconds (architecture.md). */
export const TTL = { login: 600, code: 60, access: 900, refresh: 30 * 86400 } as const
export type TokenType = keyof typeof TTL

interface Common {
  client_id: string
  scope: string
  /** Picked on the login page, capped by RC_ACCESS (D51). */
  access: Access
}

export interface LoginClaims extends Common {
  redirect_uri: string
  code_challenge: string
  state?: string
}

/** Code and refresh token carry the RC login so a dead RC token can be replaced by signing in again. */
export interface CodeClaims extends Common {
  redirect_uri: string
  code_challenge: string
  rc_token: string
  rc_user: string
  rc_password: string
}

export interface AccessClaims extends Common {
  rc_token: string
}

export interface RefreshClaims extends Common {
  rc_token: string
  rc_user: string
  rc_password: string
}

export interface Claims {
  login: LoginClaims
  code: CodeClaims
  access: AccessClaims
  refresh: RefreshClaims
}

export interface TokenScope {
  keys: ServerKeys
  /** Our issuer (the public URL). */
  issuer: string
  /** The /mcp URL: every token's aud. */
  audience: string
  now: () => Date
}

const typHeader = (t: TokenType) => `rc-mcp+${t}`

export async function seal<T extends TokenType>(s: TokenScope, typ: T, claims: Claims[T]): Promise<string> {
  const iat = Math.floor(s.now().getTime() / 1000)
  return new EncryptJWT({ ...claims } as unknown as JWTPayload)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid: s.keys.kid, typ: typHeader(typ) })
    .setIssuer(s.issuer)
    .setAudience(s.audience)
    .setIssuedAt(iat)
    .setExpirationTime(iat + TTL[typ])
    .encrypt(s.keys.jwe.get(s.keys.kid)!)
}

/** The claims, or undefined when the token is malformed, of another type, expired, or for another iss/aud. */
export async function open<T extends TokenType>(s: TokenScope, typ: T, token: string): Promise<Claims[T] | undefined> {
  try {
    const { payload } = await jwtDecrypt(
      token,
      (header) => {
        const key = header.kid ? s.keys.jwe.get(header.kid) : undefined
        if (!key) throw new Error('unknown kid')
        return key
      },
      {
        issuer: s.issuer,
        audience: s.audience,
        typ: typHeader(typ),
        currentDate: s.now(),
        clockTolerance: 0,
        keyManagementAlgorithms: ['dir'],
        contentEncryptionAlgorithms: ['A256GCM'],
      },
    )
    return payload as unknown as Claims[T]
  } catch {
    return undefined
  }
}
