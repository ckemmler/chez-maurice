/**
 * "This request came from the machine itself."
 *
 * Two surfaces need that promise and nothing else: the admin dashboard, which
 * hands out every provider API key, and the ancillary turn endpoint, which
 * spends the household's credit on behalf of a local tool. Both are reachable
 * on the same port as everything else, so the test cannot be "which port" —
 * it has to be about the request.
 *
 * Two independent signals, because neither alone is sufficient:
 *  - the Host header: a client sets it, so `Host: localhost` can be forged.
 *    But a request that arrived over the Cloudflare tunnel carries the edge's
 *    own headers (cf-ray / cf-connecting-ip), which the origin adds and a
 *    client cannot fake into a genuine loopback connection.
 *  - the socket address cannot help here: the tunnel terminates at
 *    localhost:3001, so the peer is 127.0.0.1 for tunnelled traffic too.
 *
 * So: a local Host AND no Cloudflare header. Real local use has neither
 * problem; a tunnelled request is refused whatever Host it claims.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackRequest(c: {
  req: { header(name: string): string | undefined };
}): boolean {
  const hostname = (c.req.header("host") || "").split(":")[0] ?? "";
  const isLocal = LOCAL_HOSTS.has(hostname);
  const viaCloudflare = !!c.req.header("cf-ray") || !!c.req.header("cf-connecting-ip");
  return isLocal && !viaCloudflare;
}
