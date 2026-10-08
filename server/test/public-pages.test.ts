/**
 * A member's public pages (`/@<member>/…`): which files a path may name, who
 * has an address there, and that a publish builds one member at a time.
 * The build itself is the web engine's; here it is stood in for.
 * Run with `bun test`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-public-"));
process.env.MAURICE_GARDENS_DIR = path.join(TMP, "gardens");

const { defaultSite, publicPagesDir, publicPagesHost, resolvePublicFile, servePublicPage } =
  await import("../data-api/services/publicPages");
const { siteFor } = await import("../data-api/services/gardenShelf");
const { canDeploy, deployState, requestDeploy, setDeployRunner, setPublished } =
  await import("../data-api/services/gardenWrite");
const { MEMBER } = await import("./_member");
const { default: db } = await import("../src/db");

const garden = { root: path.join(process.env.MAURICE_GARDENS_DIR!, MEMBER.username), username: MEMBER.username };

// The data directory and the household's host are read when asked for, so each
// test sets them and hands back what the rest of the run expects.
const saved = { data: process.env.MAURICE_DATA_DIR, host: process.env.MAURICE_PUBLIC_HOST, on: process.env.MAURICE_PUBLIC_PAGES };
const restore = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};
beforeEach(() => {
  process.env.MAURICE_DATA_DIR = path.join(TMP, "data");
  process.env.MAURICE_PUBLIC_HOST = "magik.chezmaurice.eu";
  process.env.MAURICE_PUBLIC_PAGES = "1";
});
afterEach(() => {
  restore("MAURICE_DATA_DIR", saved.data);
  restore("MAURICE_PUBLIC_HOST", saved.host);
  restore("MAURICE_PUBLIC_PAGES", saved.on);
});

function page(member: string, rel: string, content = "x") {
  const full = path.join(TMP, "data", "public-pages", member, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return fs.realpathSync(full);
}

beforeAll(() => {
  fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "data", "secret.txt"), "not a page");
  fs.mkdirSync(garden.root, { recursive: true });
});

afterAll(() => {
  setDeployRunner(null);
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("which file a path names", () => {
  test("the path, then .html, then its index — inside the member's folder only", () => {
    const index = page("anna", "index.html");
    const about = page("anna", "about.html");
    const fr = page("anna", "fr.html");
    const post = page("anna", "fr/blog/chine.html");
    const css = page("anna", "_astro/site.css");

    expect(resolvePublicFile("/@anna")).toBe(index);
    expect(resolvePublicFile("/@anna/")).toBe(index);
    expect(resolvePublicFile("/@anna/about")).toBe(about);
    expect(resolvePublicFile("/@anna/fr/")).toBe(fr);
    expect(resolvePublicFile("/@anna/fr/blog/chine")).toBe(post);
    expect(resolvePublicFile("/@anna/_astro/site.css")).toBe(css);
    expect(resolvePublicFile("/@anna/nope")).toBeNull();
  });

  test("nothing outside it, no dot-file, no one who has published nothing", () => {
    page("anna", "index.html");
    page("anna", ".env", "hidden");
    expect(resolvePublicFile("/@anna/../../secret.txt")).toBeNull();
    expect(resolvePublicFile("/@anna/%2e%2e/%2e%2e/secret.txt")).toBeNull();
    expect(resolvePublicFile("/@anna/..%2f..%2fsecret.txt")).toBeNull();
    expect(resolvePublicFile("/@anna/.env")).toBeNull();
    expect(resolvePublicFile("/@nobody/")).toBeNull();
    expect(resolvePublicFile("/@../anna/index.html")).toBeNull();
    expect(resolvePublicFile("/@Anna/")).toBeNull();
    // A link out of the folder is not followed out of it.
    fs.symlinkSync(path.join(TMP, "data", "secret.txt"), path.join(publicPagesDir("anna"), "leak.txt"));
    expect(resolvePublicFile("/@anna/leak.txt")).toBeNull();
  });

  test("the engine's own /@ paths are never a member's", () => {
    page("vite", "client.html");
    page("id", "index.html");
    expect(resolvePublicFile("/@vite/client")).toBeNull();
    expect(resolvePublicFile("/@id/")).toBeNull();
    expect(servePublicPage("/@vite/client")).toBeNull();
    expect(servePublicPage("/g/anna/")).toBeNull();
  });

  test("a page is served to anyone, briefly cached; built assets for good", async () => {
    page("anna", "index.html", "<h1>Anna</h1>");
    page("anna", "_astro/site.css", "body{}");
    const res = servePublicPage("/@anna/")!;
    expect(await res.text()).toBe("<h1>Anna</h1>");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(servePublicPage("/@anna/_astro/site.css")!.headers.get("cache-control")).toContain("immutable");
  });
});

describe("who has an address", () => {
  test("every member of a household that publishes, except a child", () => {
    expect(publicPagesHost()).toBe("magik.chezmaurice.eu");
    expect(defaultSite({ username: "anna" })).toBe("https://magik.chezmaurice.eu/@anna");
    expect(defaultSite({ username: "anna", is_child: true })).toBeNull();
    expect(defaultSite({ username: "vite" })).toBeNull();
  });

  test("no one, in a household that does not ask for public pages", () => {
    delete process.env.MAURICE_PUBLIC_PAGES;
    expect(defaultSite({ username: "anna" })).toBeNull();
    process.env.MAURICE_PUBLIC_PAGES = "1";
    process.env.MAURICE_PUBLIC_HOST = "localhost";
    expect(defaultSite({ username: "anna" })).toBeNull();
  });

  test("a domain of one's own comes first", () => {
    expect(siteFor(MEMBER.id)).toBe(`https://magik.chezmaurice.eu/@${MEMBER.username}`);
    db.run(`UPDATE users SET notes_domain = 'example.org' WHERE id = ?`, [MEMBER.id]);
    expect(siteFor(MEMBER.id)).toBe("https://example.org");
    db.run(`UPDATE users SET notes_domain = NULL WHERE id = ?`, [MEMBER.id]);
  });
});

describe("publishing to one's pages", () => {
  test("builds the member's pages, one build at a time per member", async () => {
    const built: string[] = [];
    let release: () => void = () => {};
    setDeployRunner((g) => new Promise<void>((resolve) => { built.push(g.username); release = resolve; }));

    fs.mkdirSync(path.join(garden.root, "movies/fr"), { recursive: true });
    fs.writeFileSync(path.join(garden.root, "movies/fr/perfect-days.md"),
      `---\ntitle: Perfect Days\nflags: []\nlocale: fr\n---\nUn homme nettoie des toilettes.\n`);

    expect(canDeploy(MEMBER.id, garden)).toBe(true);
    const ref = { collection: "movies", locale: "fr", slug: "perfect-days" };
    expect(setPublished(MEMBER.id, garden, ref, true).status).toBe("running");
    expect(built).toEqual([MEMBER.username]);

    // Another member's publish does not wait for this one.
    const other = { root: path.join(TMP, "gardens", "anna"), username: "anna" };
    expect(requestDeploy(other, "pages").status).toBe("running");
    expect(deployState("anna").status).toBe("running");
    expect(requestDeploy(garden, "pages").status).toBe("queued");
    expect(built).toEqual([MEMBER.username, "anna"]);
    release();   // anna's
    await new Promise((r) => setTimeout(r, 5));
    expect(deployState("anna").status).toBe("idle");
    expect(deployState(MEMBER.username).status).toBe("queued");
  });

  test("refused where the household publishes nothing", () => {
    setDeployRunner(() => Promise.resolve());
    delete process.env.MAURICE_PUBLIC_PAGES;
    expect(canDeploy(MEMBER.id, garden)).toBe(false);
    expect(() => setPublished(MEMBER.id, garden, { collection: "movies", locale: "fr", slug: "perfect-days" }, true))
      .toThrow("No site");
  });
});
