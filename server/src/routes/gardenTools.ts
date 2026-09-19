/**
 * The garden toolbar's API — what the owner's toolbar in a garden page calls.
 *
 *   POST /api/v1/garden-tools/public-state      → { file, public }
 *   POST /api/v1/garden-tools/toggle-public     → { file, public }
 *   POST /api/v1/garden-tools/private-state     → { file, private }
 *   POST /api/v1/garden-tools/toggle-private    → { file, private }
 *   POST /api/v1/garden-tools/content-path      → { contentPath, absPath, repo… }
 *   POST /api/v1/garden-tools/delete-note       → { deleted }
 *   POST /api/v1/garden-tools/review-state      → { file, unreviewed }
 *   POST /api/v1/garden-tools/review-note       → { file, unreviewed, reviewed } — keep a note Maurice wrote
 *   POST /api/v1/garden-tools/reorder-children  → { updated, count }
 *   POST /api/v1/garden-tools/social-state      → the sharing panel's state
 *   POST /api/v1/garden-tools/social-publish    → { ok, url | post_urn }
 *   POST /api/v1/garden-tools/translate         → a stream of the run's output
 *
 * Every route acts on the caller's OWN garden — there is no member in the URL,
 * so there is no way to aim one of these at someone else's. That is the whole
 * reason they moved here from the dev server (see services/gardenTools.ts).
 * `/api/v1/*` already refuses an unauthenticated request.
 */
import { Hono } from "hono";
import path from "node:path";
import { existsSync } from "node:fs";
import { isGuest } from "../services/users";
import { watchGarden } from "../services/gardenWatch";
import { gardenFor } from "../../data-api/services/gardenFiche";
import {
  REPO_ROOT, deleteNote, editorTargets, privateState, publicState, recordShare,
  reorderChildren, repoPython, resolveContentFile, reviewNote, reviewState, socialState, togglePrivate, togglePublic,
  type GardenRef,
} from "../services/gardenTools";

const tools = new Hono();

/** The caller's own garden, or the response that refuses. */
function mine(c: any): GardenRef | Response {
  const memberId = c.get("userId") as string;
  // A guest has no garden of their own — the whole section does not exist for
  // them (mirrors /api/v1/gardens).
  if (isGuest(memberId)) return c.json({ error: "Forbidden" }, 403);
  const garden = gardenFor(memberId);
  if (!garden || !existsSync(garden.root)) return c.json({ error: "No garden" }, 404);
  return garden;
}

/** Body shape shared by most routes: the browser's location.pathname. */
async function urlPath(c: any): Promise<string | null> {
  const body = (await c.req.json().catch(() => ({}))) as { path?: unknown };
  return typeof body.path === "string" ? body.path : null;
}

function handle(
  route: string,
  fn: (garden: GardenRef, p: string) => unknown | null,
  notFound = "No content file found",
) {
  tools.post(route, async (c) => {
    const garden = mine(c);
    if (garden instanceof Response) return garden;
    const p = await urlPath(c);
    if (p === null) return c.json({ error: "path required" }, 400);
    try {
      const result = fn(garden, p);
      return result ? c.json(result) : c.json({ error: notFound }, 404);
    } catch (err) {
      console.error(`[garden-tools] ${route}:`, (err as Error).message);
      return c.json({ error: "Failed" }, 500);
    }
  });
}

handle("/public-state", publicState);
handle("/toggle-public", togglePublic);
handle("/private-state", privateState, "Not a note");
handle("/toggle-private", togglePrivate, "Not a note");
handle("/delete-note", deleteNote, "Not a notes page");
handle("/review-state", reviewState, "Not a note");
handle("/review-note", reviewNote, "Not a note");
handle("/social-state", socialState, "Not a shareable page");
handle("/content-path", (garden, p) => {
  const found = resolveContentFile(garden, p);
  return found ? editorTargets(garden, found.filePath) : null;
});

tools.post("/reorder-children", async (c) => {
  const garden = mine(c);
  if (garden instanceof Response) return garden;
  const body = (await c.req.json().catch(() => ({}))) as { items?: unknown };
  if (!Array.isArray(body.items)) return c.json({ error: "items array required" }, 400);
  try {
    return c.json(reorderChildren(garden, body.items as Array<{ slug: string; order: number }>));
  } catch (err) {
    console.error("[garden-tools] reorder-children:", (err as Error).message);
    return c.json({ error: "Failed" }, 500);
  }
});

/**
 * A stream of "this changed" for the caller's own garden, so an open page can
 * refresh itself when Maurice (or the owner, or the toolbar) writes to it.
 * This is what replaces Vite's HMR socket, which only existed because the
 * engine was a dev server. Events carry a slug, never content.
 */
tools.get("/events", (c) => {
  const garden = mine(c);
  if (garden instanceof Response) return garden;
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      send("ready", { garden: garden.username });
      unsubscribe = watchGarden(garden.username, (change) => {
        try { send("changed", change); } catch { /* closed */ }
      });
      // A comment every 25 s so an idle connection is not reaped by a proxy.
      const beat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": beat\n\n")); } catch { clearInterval(beat); }
      }, 25_000);
      (beat as { unref?: () => void }).unref?.();
    },
    cancel() { unsubscribe(); },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
});

// ── The owner's publishing pipeline ─────────────────────────────
//
// Both routes below run something from the source checkout (a python CLI, a
// tsx script). An install that is not a checkout — the container, a client's
// machine — has neither, and they answer 501 rather than pretend.

tools.post("/social-publish", async (c) => {
  const garden = mine(c);
  if (garden instanceof Response) return garden;
  const body = (await c.req.json().catch(() => ({}))) as {
    platform?: string; text?: string; image_url?: string;
    article_url?: string; content_path?: string;
  };
  if (body.platform !== "twitter" && body.platform !== "linkedin") {
    return c.json({ error: "Invalid platform" }, 400);
  }
  const python = repoPython();
  const cli = path.join(REPO_ROOT, "tools/social/publish_cli.py");
  if (!python || !existsSync(cli)) {
    return c.json({ error: "Publishing tools are not installed on this server" }, 501);
  }

  const args = [cli, "--platform", body.platform, "--text", body.text ?? ""];
  if (body.image_url) args.push("--image-url", body.image_url);
  if (body.article_url) args.push("--article-url", body.article_url);

  const proc = Bun.spawn([python, ...args], {
    cwd: path.join(REPO_ROOT, "tools/social"),
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) {
    console.error("[garden-tools] social-publish failed:", (err || out).slice(0, 300));
    return c.json({ error: out || err || `Exit code ${code}` }, 500);
  }
  let result: { url?: string; post_urn?: string };
  try {
    result = JSON.parse(out);
  } catch {
    return c.json({ error: `Parse error: ${out.slice(0, 300)}` }, 500);
  }
  if (body.content_path) recordShare(garden, body.content_path, body.platform, result);
  return c.json({ ok: true, ...result });
});

tools.post("/translate", async (c) => {
  const garden = mine(c);
  if (garden instanceof Response) return garden;
  const script = path.join(REPO_ROOT, "web/scripts/translate-content.ts");
  if (!existsSync(script)) {
    return c.json({ error: "Translation script is not installed on this server" }, 501);
  }

  // Server-sent events: the toolbar shows the last line as it arrives, so the
  // owner sees a long run progress instead of a frozen button.
  const proc = Bun.spawn(["npx", "tsx", script], {
    cwd: path.join(REPO_ROOT, "web"),
    env: { ...process.env, GARDEN: garden.username },
    stdout: "pipe", stderr: "pipe",
  });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (text: string, prefix = "") =>
        controller.enqueue(encoder.encode(`data: ${prefix}${text.replace(/\n/g, `\ndata: ${prefix}`)}\n\n`));
      const pump = async (readable: ReadableStream<Uint8Array>, prefix: string) => {
        for await (const chunk of readable) send(new TextDecoder().decode(chunk), prefix);
      };
      await Promise.all([pump(proc.stdout, ""), pump(proc.stderr, "[ERR] ")]);
      send(`[DONE] exit code ${await proc.exited}`);
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
});

export default tools;
