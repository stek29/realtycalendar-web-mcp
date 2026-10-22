// The client's address for logs, behind a known number of reverse proxies (MCP_TRUST_PROXY_HOPS).

/**
 * Each trusted proxy appends the address it got the request from to X-Forwarded-For, so the client is `hops` entries
 * from the right of [...X-Forwarded-For, socket address]. Entries further left are whatever the client sent and are
 * never trusted. With 0 hops the header is ignored. Too few entries → the leftmost one there is.
 */
export function clientIp(
  socketIp: string | undefined,
  forwardedFor: string | undefined,
  hops: number,
): string | undefined {
  if (hops <= 0 || !forwardedFor) return socketIp
  const chain = [
    ...forwardedFor
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ...(socketIp ? [socketIp] : []),
  ]
  return chain[Math.max(0, chain.length - 1 - hops)]
}
