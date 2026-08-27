/**
 * Keeping the semantic index in step with what this server writes.
 *
 * The Python garden tool pushes each write to the corpus in-process. The Bun
 * server cannot: the corpus runs inside the MCP gateway, whose file watcher is
 * deliberately off (`corpus_server_context(watch=False)`). So an article fiche
 * written here — by the share sheet, the browser clipper, or the summariser —
 * would sit on disk indexed by nothing.
 *
 * It goes back out the way every other cross-process corpus call does: through
 * the gateway, scoped to the member, fire-and-forget. A failure costs a fiche
 * its place in search until the next `reindex`, which is not worth failing a
 * save over.
 */

import path from "node:path";
import { corpusCall } from "../../src/services/mcpClient";

/**
 * Which corpus source owns a path — the same rule as `_corpus_source_for` in
 * the garden MCP tool. Each source filters paths that are not its own, so a
 * wrong guess is indexed nowhere rather than indexed wrongly.
 */
export function corpusSourceFor(file: string): string {
  if (file.endsWith(".frag")) return "garden-fragments";
  if (path.basename(file, path.extname(file)).endsWith("-fiche")) return "garden-fiches";
  // <member>/notes/<locale>/<slug>.md — anything else at that depth is a
  // published card (a resource entry, a blog post, an essay, a page).
  if (path.basename(path.dirname(path.dirname(file))) === "notes") return "garden-notes";
  return "garden-cards";
}

/** Index the markdown among these paths. Images and other files are skipped. */
export function indexGardenPaths(memberId: string, paths: string[]): void {
  for (const file of paths) {
    if (!/\.(md|mdx|frag)$/.test(file)) continue;
    corpusCall(memberId, "index_path", { source: corpusSourceFor(file), path: file }).catch(
      (err) => console.warn(`[corpus] index_path(${path.basename(file)}) failed: ${err?.message || err}`),
    );
  }
}

export function unindexGardenPath(memberId: string, file: string): void {
  corpusCall(memberId, "index_path", {
    source: corpusSourceFor(file),
    path: file,
    deleted: true,
  }).catch((err) => console.warn(`[corpus] unindex(${path.basename(file)}) failed: ${err?.message || err}`));
}
