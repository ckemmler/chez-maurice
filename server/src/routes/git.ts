// /git/<member>.git — a member's garden as a git address (17 October 2026),
// read-only, for `git clone`, Obsidian Git and Working Copy.
//
// HTTP Basic: any username, a `maur_…` token as the password — a `git` token
// (minted by GET /api/me/git, opens this and nothing else) or a `full` one.
// The token's member must be the garden's: a member clones their own garden
// and no one else's, whatever is shared with them on the web. Fetching only:
// a push is refused, in words git shows its user, before any credential is
// asked for. services/gitHttp.ts runs git's own http-backend behind this.

import { Hono } from "hono";
import { join } from "node:path";
import { validateGitToken } from "../middleware/auth";
import { ensureGardenRepo, isGardenDir, serveGitHttp, text } from "../services/gitHttp";
import { gardensRoot } from "../services/gardensRoot";
import { getUser } from "../services/users";

const READ_ONLY =
  "This garden is read-only: Maurice serves clones and fetches, not pushes (yet).\n" +
  "Ce jardin est en lecture seule : Maurice sert les clones, pas encore les envois (push).";

const git = new Hono();

/** The member a request's Basic credentials belong to, or null. */
async function basicMember(header: string | undefined): Promise<string | null> {
  if (!header?.startsWith("Basic ")) return null;
  let decoded: string;
  try { decoded = atob(header.slice(6).trim()); } catch { return null; }
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return validateGitToken(password);
}

git.all("/*", async (c) => {
  const m = c.req.path.match(/^\/git\/([A-Za-z0-9][A-Za-z0-9._-]*)\.git(\/.*)?$/);
  if (!m) return text(404, "Not a garden address.");
  const [, member, sub = "/"] = m;
  const service = c.req.query("service");

  if (sub === "/git-receive-pack" || service === "git-receive-pack") return text(403, READ_ONLY);
  const advert = c.req.method === "GET" && sub === "/info/refs" && service === "git-upload-pack";
  const fetch = c.req.method === "POST" && sub === "/git-upload-pack";
  if (!advert && !fetch) return text(404, "Only git's smart HTTP protocol is served here.");

  const userId = await basicMember(c.req.header("Authorization"));
  if (!userId) {
    return text(401, "A Maurice git token is the password (Settings → My data).", {
      "WWW-Authenticate": 'Basic realm="Maurice", charset="UTF-8"',
    });
  }
  const user = getUser(userId);
  if (!user || user.username !== member) return text(403, "This garden is not yours.");

  const root = join(gardensRoot(), member);
  if (!isGardenDir(root)) return text(404, "You have no garden on this household.");
  const repo = ensureGardenRepo(root);
  if (!repo.ok) {
    console.error(`[git] ${member}: ${repo.reason}`);
    return text(409, `This garden cannot be served: ${repo.reason}.`);
  }
  if (repo.created) console.log(`[git] ${member}: garden put under version control`);

  return serveGitHttp(c.req.raw, root, sub, member);
});

export default git;
