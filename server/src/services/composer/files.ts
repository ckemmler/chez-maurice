import { listLibrary, readFile, type FolderRow, type FileRow } from "../files";
import { estimateTokens } from "./notes";

// The composer's view of a member's file library (services/files.ts owns storage
// + CRUD). Files are a 4th context type alongside notes/books/conversations:
//   • a `file` item is one leaf — text files carry a token weight, binaries
//     (img/pdf) are uncounted and ride along as attachments.
//   • a `folder` item fans out over its descendant files (like a MOC over notes):
//     `recurse` walks subfolders, `exclude` drops files/subfolders + their subtree.
// Token weight is the same char/4 estimate used everywhere (text files only).

// ── Per-user library index (folders/files keyed + grouped by parent) ──
interface LibIndex {
  folders: Map<string, FolderRow>;
  files: Map<string, FileRow>;
  subFolders: Map<string | null, FolderRow[]>; // by parent_id
  folderFiles: Map<string | null, FileRow[]>; // by folder_id
}

function indexLibrary(userId: string): LibIndex {
  const { folders, files } = listLibrary(userId);
  const idx: LibIndex = {
    folders: new Map(),
    files: new Map(),
    subFolders: new Map(),
    folderFiles: new Map(),
  };
  for (const f of folders) {
    idx.folders.set(f.id, f);
    const k = f.parent_id;
    (idx.subFolders.get(k) ?? idx.subFolders.set(k, []).get(k)!).push(f);
  }
  for (const f of files) {
    idx.files.set(f.id, f);
    const k = f.folder_id;
    (idx.folderFiles.get(k) ?? idx.folderFiles.set(k, []).get(k)!).push(f);
  }
  return idx;
}

const isText = (kind: string) => kind === "text";

/** Breadcrumb to a folder/file: "Notes / Trips" (parent chain, root → leaf). */
function pathOf(idx: LibIndex, folderId: string | null): string {
  const parts: string[] = [];
  let cur = folderId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const f = idx.folders.get(cur);
    if (!f) break;
    parts.unshift(f.name);
    cur = f.parent_id;
  }
  return parts.join(" / ");
}

const sizeLabel = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

// ── Search: files + folders for the omnibox ──────────────────────────────────
export interface FileSearchHit {
  type: "file" | "folder";
  id: string;
  title: string;
  sub: string;
  kind?: string; // file kind (text/img/pdf/file)
}

/** Files + folders whose name matches `ql` (already lowercased). Empty → all. */
export function searchFiles(userId: string, ql: string): FileSearchHit[] {
  const idx = indexLibrary(userId);
  const out: FileSearchHit[] = [];
  const hit = (name: string) => !ql || name.toLowerCase().includes(ql);

  for (const f of idx.folders.values()) {
    if (!hit(f.name)) continue;
    const n = (idx.folderFiles.get(f.id)?.length ?? 0);
    const path = pathOf(idx, f.parent_id);
    out.push({
      type: "folder",
      id: f.id,
      title: f.name,
      sub: [`folder · ${n} file${n === 1 ? "" : "s"}`, path].filter(Boolean).join(" · "),
    });
  }
  for (const f of idx.files.values()) {
    if (!hit(f.name)) continue;
    const path = pathOf(idx, f.folder_id);
    out.push({
      type: "file",
      id: f.id,
      title: f.name,
      kind: f.kind,
      sub: [`${f.kind} · ${sizeLabel(f.size_bytes)}`, path].filter(Boolean).join(" · "),
    });
  }
  return out;
}

// ── Single file resolution ───────────────────────────────────────────────────
export interface ResolvedFile {
  weight: number;
  kind: string;
  name: string;
  na: boolean; // binary: no token estimate (rides along as an attachment)
  sizeBytes: number;
  path: string;
  missing?: boolean;
}

export function resolveFileItem(userId: string, fileId: string): ResolvedFile {
  const idx = indexLibrary(userId);
  const f = idx.files.get(fileId);
  if (!f) return { weight: 0, kind: "file", name: String(fileId), na: true, sizeBytes: 0, path: "", missing: true };
  const na = !isText(f.kind);
  return {
    weight: na ? 0 : f.token_estimate ?? 0,
    kind: f.kind,
    name: f.name,
    na,
    sizeBytes: f.size_bytes,
    path: pathOf(idx, f.folder_id),
  };
}

// ── Folder resolution: descendant tree + included set ────────────────────────
// Mirrors notes' resolveSubtree. The folder is the anchor; its files/subfolders
// resolve when `recurse` (default ON — folders are containers). `exclude` drops
// a file or subfolder AND its subtree. Binaries appear in the tree (counted as
// attachments) but contribute 0 weight and carry `na: true`.
export interface FileTreeNode {
  id: string;
  name: string;
  isFolder: boolean;
  kind: string; // "folder" | text | img | pdf | file
  weight: number;
  na: boolean;
  childCount: number;
  included: boolean;
  excluded: boolean;
  children: FileTreeNode[];
}

export interface ResolvedFolder {
  weight: number;
  count: number; // included files (text + binary)
  textCount: number;
  binaryCount: number;
  title: string;
  hasChildren: boolean;
  manualExcluded: number;
  includedTextIds: string[];
  includedBinaryIds: string[];
  tree: FileTreeNode;
  missing?: boolean;
}

export function resolveFolderItem(
  userId: string,
  it: { id: string; recurse?: boolean; exclude?: string[] },
): ResolvedFolder | null {
  const idx = indexLibrary(userId);
  const root = idx.folders.get(it.id);
  if (!root) return null;

  const recurse = it.recurse ?? true;
  const excludedSet = new Set(it.exclude ?? []);
  const includedTextIds: string[] = [];
  const includedBinaryIds: string[] = [];

  const fileNode = (f: FileRow, excludedAncestor: boolean): FileTreeNode => {
    const excluded = excludedAncestor || excludedSet.has(f.id);
    const na = !isText(f.kind);
    const included = !excluded;
    if (included) (na ? includedBinaryIds : includedTextIds).push(f.id);
    return {
      id: f.id, name: f.name, isFolder: false, kind: f.kind,
      weight: na ? 0 : f.token_estimate ?? 0, na, childCount: 0, included, excluded, children: [],
    };
  };

  const walk = (folderId: string, excludedAncestor: boolean, isRoot: boolean): FileTreeNode => {
    const folder = idx.folders.get(folderId)!;
    const excluded = excludedAncestor || (!isRoot && excludedSet.has(folderId));
    const enter = isRoot || (recurse && !excluded);
    const kids: FileTreeNode[] = [];
    if (enter) {
      for (const sub of idx.subFolders.get(folderId) ?? []) kids.push(walk(sub.id, excluded, false));
      for (const f of idx.folderFiles.get(folderId) ?? []) kids.push(fileNode(f, excluded));
    }
    return {
      id: folder.id, name: folder.name, isFolder: true, kind: "folder",
      weight: 0, na: false, childCount: kids.length,
      included: !excluded, excluded, children: kids,
    };
  };

  const tree = walk(it.id, false, true);

  let weight = 0, textCount = 0, binaryCount = 0;
  const collect = (n: FileTreeNode) => {
    if (!n.isFolder && n.included) {
      if (n.na) binaryCount++; else { textCount++; weight += n.weight; }
    }
    n.children.forEach(collect);
  };
  collect(tree);

  const directChildren = (idx.subFolders.get(it.id)?.length ?? 0) + (idx.folderFiles.get(it.id)?.length ?? 0);
  return {
    weight, count: textCount + binaryCount, textCount, binaryCount,
    title: root.name, hasChildren: directChildren > 0, manualExcluded: excludedSet.size,
    includedTextIds, includedBinaryIds, tree,
  };
}

// ── Content for context-building ─────────────────────────────────────────────

/** A text file's content, framed for the loaded-context block. "" if missing/binary. */
export function fileText(userId: string, fileId: string): string {
  const r = readFile(userId, fileId);
  if (!r || r.kind !== "text") return "";
  return `# ${r.name}\n\n${r.buffer.toString("utf8")}`;
}

export interface FileAttachment {
  kind: string; // "img" | "pdf"
  name: string;
  mediaType: string;
  base64: string;
}

const mediaTypeFor = (name: string, kind: string): string => {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (kind === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
};

/** A binary file (img/pdf) as a base64 attachment for the model. null otherwise. */
export function fileBinary(userId: string, fileId: string): FileAttachment | null {
  const r = readFile(userId, fileId);
  if (!r || (r.kind !== "img" && r.kind !== "pdf")) return null;
  return { kind: r.kind, name: r.name, mediaType: mediaTypeFor(r.name, r.kind), base64: r.buffer.toString("base64") };
}
