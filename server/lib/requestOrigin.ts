/**
 * The household's address as a request reached it: through the Cloudflare
 * tunnel or a reverse proxy, the public one (`X-Forwarded-Proto` / `-Host`),
 * else what the request itself says. For the links and addresses the server
 * hands back to a member — the join page, a reply's footer, the garden's
 * clone address.
 */
export function requestOrigin(req: { header(name: string): string | undefined; url: string }): string {
  const url = new URL(req.url);
  const first = (v: string | undefined) => v?.split(",")[0]?.trim() || undefined;
  const proto = first(req.header("x-forwarded-proto")) ?? url.protocol.replace(/:$/, "");
  const host = first(req.header("x-forwarded-host")) ?? req.header("host") ?? url.host;
  return `${proto}://${host}`;
}
