/**
 * "This request came from the machine itself."
 *
 * Two surfaces need that promise and nothing else: the admin dashboard, which
 * hands out every provider API key, and the ancillary turn endpoint, which
 * spends the household's credit on behalf of a local tool. Both are reachable
 * on the same port as everything else, so the test cannot be "which port" —
 * it has to be about the request.
 *
 * Three independent signals, because none alone is sufficient:
 *  - the socket peer: the server listens on 0.0.0.0, so a machine on the LAN
 *    or on the tailnet reaches this port directly, and in the container Caddy
 *    reaches it from its own compose address. Neither is 127.0.0.1. A peer
 *    that is not loopback did not come from this machine, whatever it says.
 *  - the Host header: a client sets it, so `Host: localhost` can be forged.
 *    It still matters, because the Cloudflare tunnel terminates on this
 *    machine — its peer IS 127.0.0.1 — and a browser on the public origin
 *    sends the public Host. Host alone was the only test until 18 September
 *    2026, and Host alone is exactly what a LAN client forges.
 *  - a request that arrived over the Cloudflare tunnel carries the edge's own
 *    headers (cf-ray / cf-connecting-ip), which the origin adds and a client
 *    cannot fake into a genuine loopback connection.
 *
 * So: a loopback peer AND a local Host AND no Cloudflare header. Real local
 * use — a tool beside the database, the admin on the Mac — has all three; a
 * tunnelled or LAN request fails at least one whatever Host it claims.
 *
 * The peer comes from Bun's `server.requestIP()`, which Hono exposes as
 * `c.env` because index.ts calls `app.fetch(req, srv)`. A test harness that
 * calls `route.request()` has no socket and no env: the peer is then unknown
 * and only the two header tests apply, which is what those tests exercise.
 * When a server IS there, an unknown or missing address is a refusal, not a
 * pass — the point of the test is to vouch, and it cannot.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** 127.0.0.0/8, ::1, and IPv4 loopback seen through an IPv6 socket. */
function isLoopbackAddress(address: string): boolean {
  if (address === "::1") return true;
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return v4.startsWith("127.");
}

type PeerLookup = { requestIP?: (req: Request) => { address: string } | null };

/**
 * Where the socket came from: "loopback", "remote", or "unknown" when there
 * is no server to ask (a test harness driving the app without a socket).
 */
function peer(c: { env?: unknown; req: { raw: Request } }): "loopback" | "remote" | "unknown" {
  const env = c.env as PeerLookup | undefined;
  if (!env || typeof env.requestIP !== "function") return "unknown";
  let info: { address: string } | null;
  try {
    info = env.requestIP(c.req.raw);
  } catch {
    return "remote";
  }
  if (!info?.address) return "remote";
  return isLoopbackAddress(info.address) ? "loopback" : "remote";
}

export function isLoopbackRequest(c: {
  env?: unknown;
  req: { raw: Request; header(name: string): string | undefined };
}): boolean {
  if (peer(c) === "remote") return false;
  const hostname = (c.req.header("host") || "").split(":")[0] ?? "";
  const isLocal = LOCAL_HOSTS.has(hostname);
  const viaCloudflare = !!c.req.header("cf-ray") || !!c.req.header("cf-connecting-ip");
  return isLocal && !viaCloudflare;
}
