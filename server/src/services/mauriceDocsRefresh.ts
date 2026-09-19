import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAppDir } from "../../lib/appDir";
import { safeFetch } from "../../data-api/services/articleExtract";

// The Maurice system documentation refreshes itself. The image ships a
// snapshot of the notes (docs/maurice/, copied there by scripts/sync-docs.sh),
// but a hosted household only gets a newer one when its image is rebuilt and
// recreated — so the documentation tool would answer from whatever the container was
// built with. The notes are committed and pushed with the code, which makes
// the public repo the publication channel: every instance fetches the
// manifest sync-docs.sh writes beside them, and when it is newer than what it
// has, pulls the notes that changed into a directory of its own on the
// writable volume. mauriceDocs.ts reads from there once it is newer than the
// bundle.
//
// What keeps it safe: the base URL is an operator setting, so every request
// goes through the SSRF guard the article extractor uses; each download is
// capped and verified against the manifest's sha256; and the set is staged in
// a sibling directory and swapped in whole, so a failure half-way — network,
// a bad hash — leaves the previous set as it was.

export const DEFAULT_DOCS_URL = "https://raw.githubusercontent.com/ckemmler/chez-maurice/main/docs/maurice";

const MANIFEST = "manifest.json";
const MANIFEST_CAP = 64 * 1024;
const NOTE_CAP = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const FIRST_RUN_MS = 20_000;
const PERIOD_MS = 24 * 60 * 60 * 1000;

export interface DocsManifestNote {
  file: string;
  slug: string;
  date: string | null;
  bytes: number;
  sha256: string;
}

export interface DocsManifest {
  format: "maurice-docs";
  version: number;
  generated_at: string;
  notes: DocsManifestNote[];
}

export type DocsSource = "env" | "refreshed" | "bundled";
export type RefreshOutcome = "off" | "unchanged" | "refreshed" | "failed";

/** Where the published set lives, or null when refreshing is off: an explicit
 *  `MAURICE_DOCS_URL=off` (a self-hosted install that wants no outbound call),
 *  or the test suite, which must never reach the network. */
export function docsUrl(): string | null {
  const env = process.env.MAURICE_DOCS_URL?.trim();
  if (env === "off") return null;
  if (env) return env.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "test") return null;
  return DEFAULT_DOCS_URL;
}

/** The snapshot the image carries: server/src/services -> <repo>/docs/maurice. */
export function bundledDocsDir(): string {
  return resolve(import.meta.dir, "../../../docs/maurice");
}

/** The refreshed set, on the app dir — the writable volume of a hosted instance. */
export function refreshedDocsDir(): string {
  return join(getAppDir(), "docs", "maurice");
}

// ── Manifest ────────────────────────────────────────────────────

function parseManifest(raw: string): DocsManifest {
  const m = JSON.parse(raw);
  if (!m || m.format !== "maurice-docs" || typeof m.generated_at !== "string" || !Array.isArray(m.notes)) {
    throw new Error("not a maurice-docs manifest");
  }
  if (Number.isNaN(Date.parse(m.generated_at))) throw new Error(`bad generated_at: ${m.generated_at}`);
  const notes: DocsManifestNote[] = m.notes.map((n: any) => {
    // The file name becomes a path under the target dir: only a note's shape.
    if (typeof n?.file !== "string" || !/^maurice-[A-Za-z0-9_-]+\.md$/.test(n.file)) {
      throw new Error(`bad note name: ${String(n?.file)}`);
    }
    if (typeof n.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(n.sha256)) throw new Error(`${n.file}: bad sha256`);
    if (!Number.isInteger(n.bytes) || n.bytes < 0 || n.bytes > NOTE_CAP) throw new Error(`${n.file}: bad size`);
    return {
      file: n.file,
      slug: n.file.replace(/\.md$/, ""),
      date: typeof n.date === "string" ? n.date : null,
      bytes: n.bytes,
      sha256: n.sha256,
    };
  });
  return { format: "maurice-docs", version: Number(m.version) || 1, generated_at: m.generated_at, notes };
}

// Keyed on the file's identity and mtime: docsDir() asks on every load of the
// persona, and a swap replaces the inode.
const manifestCache = new Map<string, { key: string; manifest: DocsManifest | null }>();

/** The manifest in a docs dir, or null when there is none or it is not one. */
export function readManifest(dir: string): DocsManifest | null {
  const p = join(dir, MANIFEST);
  let key: string;
  try {
    const st = statSync(p);
    key = `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    manifestCache.delete(dir);
    return null;
  }
  const hit = manifestCache.get(dir);
  if (hit && hit.key === key) return hit.manifest;
  let manifest: DocsManifest | null = null;
  try {
    manifest = parseManifest(readFileSync(p, "utf8"));
  } catch {
    manifest = null;
  }
  manifestCache.set(dir, { key, manifest });
  return manifest;
}

function isNewer(a: string, b: string): boolean {
  const ta = Date.parse(a), tb = Date.parse(b);
  return Number.isNaN(ta) || Number.isNaN(tb) ? a > b : ta > tb;
}

/** The set the documentation tool reads: MAURICE_DOCS_DIR when set (live garden
 *  notes), else the refreshed set when it is at least as new as the bundled
 *  one, else the bundle. */
export function pickDocsDir(): { source: DocsSource; dir: string; manifest: DocsManifest | null } {
  const env = process.env.MAURICE_DOCS_DIR;
  if (env) return { source: "env", dir: env, manifest: null };
  const bundledDir = bundledDocsDir();
  const bundled = readManifest(bundledDir);
  const refreshedDir = refreshedDocsDir();
  const refreshed = readManifest(refreshedDir);
  if (refreshed && (!bundled || !isNewer(bundled.generated_at, refreshed.generated_at))) {
    return { source: "refreshed", dir: refreshedDir, manifest: refreshed };
  }
  return { source: "bundled", dir: bundledDir, manifest: bundled };
}

// ── Refresh ─────────────────────────────────────────────────────

let lastCheckAt: string | null = null;
let lastError: string | null = null;
let inflight: Promise<RefreshOutcome> | null = null;

export function docsStatus(): {
  source: DocsSource;
  generated_at: string | null;
  last_check_at: string | null;
  last_error: string | null;
} {
  const pick = pickDocsDir();
  return {
    source: pick.source,
    generated_at: pick.manifest?.generated_at ?? null,
    last_check_at: lastCheckAt,
    last_error: lastError,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** GET with the server's SSRF guard, a timeout and a size cap, whatever the
 *  headers say. `MAURICE_DOCS_ALLOW_LOCAL=1` lifts the guard: the tests serve
 *  from 127.0.0.1, which it refuses by design, and a LAN mirror needs the same
 *  door — one named switch rather than a second fetch path. */
async function fetchCapped(url: string, cap: number): Promise<Uint8Array> {
  const init: RequestInit = { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "*/*" } };
  const resp = process.env.MAURICE_DOCS_ALLOW_LOCAL === "1" ? await fetch(url, init) : await safeFetch(url, init);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  const declared = Number(resp.headers.get("content-length") || 0);
  if (declared > cap) throw new Error(`${url}: ${declared} bytes, over the ${cap}-byte cap`);
  const reader = resp.body?.getReader();
  if (!reader) throw new Error(`${url}: empty response`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      reader.cancel().catch(() => {});
      throw new Error(`${url}: over the ${cap}-byte cap`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** A copy of the note already on disk with the manifest's hash — the current
 *  set first, then the bundle — so an unchanged note is never downloaded. */
function localCopy(note: DocsManifestNote, dirs: string[]): Uint8Array | null {
  for (const dir of dirs) {
    const p = join(dir, note.file);
    try {
      if (statSync(p).size !== note.bytes) continue;
      const bytes = readFileSync(p);
      if (sha256(bytes) === note.sha256) return bytes;
    } catch {
      // absent or unreadable: download it
    }
  }
  return null;
}

/** Two renames: the target steps aside, the stage takes its place. The window
 *  between them has no target dir, which docsDir() answers with the bundle. */
function swapIn(stage: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const previous = target + ".previous";
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(target)) renameSync(target, previous);
  try {
    renameSync(stage, target);
  } catch (err) {
    if (existsSync(previous)) renameSync(previous, target);
    throw err;
  }
  rmSync(previous, { recursive: true, force: true });
}

async function doRefresh(): Promise<RefreshOutcome> {
  const base = docsUrl();
  if (!base) return "off";
  lastCheckAt = new Date().toISOString();
  const target = refreshedDocsDir();
  const stage = target + ".staging";
  try {
    const remote = parseManifest(new TextDecoder().decode(await fetchCapped(`${base}/${MANIFEST}`, MANIFEST_CAP)));
    const current = readManifest(target) ?? readManifest(bundledDocsDir());
    if (current && !isNewer(remote.generated_at, current.generated_at)) {
      lastError = null;
      console.log(`[docs] up to date (${current.generated_at})`);
      return "unchanged";
    }
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    let downloaded = 0;
    for (const note of remote.notes) {
      let bytes = localCopy(note, [target, bundledDocsDir()]);
      if (!bytes) {
        bytes = await fetchCapped(`${base}/${note.file}`, NOTE_CAP);
        downloaded++;
        if (bytes.byteLength !== note.bytes || sha256(bytes) !== note.sha256) {
          throw new Error(`${note.file}: does not match the manifest's sha256`);
        }
      }
      writeFileSync(join(stage, note.file), bytes);
    }
    // The manifest last: its presence is what says the set beside it is whole.
    writeFileSync(join(stage, MANIFEST), JSON.stringify(remote, null, 2) + "\n");
    swapIn(stage, target);
    lastError = null;
    console.log(`[docs] refreshed to ${remote.generated_at}: ${remote.notes.length} note(s), ${downloaded} downloaded`);
    return "refreshed";
  } catch (err) {
    rmSync(stage, { recursive: true, force: true });
    lastError = (err as Error).message;
    console.error(`[docs] refresh failed: ${lastError}`);
    return "failed";
  }
}

/** Fetch the published manifest and bring the local set up to it. Never
 *  throws; a check already running is shared rather than doubled. */
export function refreshDocs(): Promise<RefreshOutcome> {
  if (!inflight) {
    inflight = doRefresh().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Once, shortly after boot — never delaying a start — then daily. */
export function scheduleDocsRefresh(): void {
  if (!docsUrl()) {
    console.log("[docs] refresh off");
    return;
  }
  const run = () => {
    refreshDocs().catch((err) => console.error(`[docs] refresh failed: ${(err as Error).message}`));
  };
  setTimeout(() => {
    run();
    setInterval(run, PERIOD_MS).unref();
  }, FIRST_RUN_MS).unref();
}
