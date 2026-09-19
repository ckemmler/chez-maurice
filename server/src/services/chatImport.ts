// Importing a member's chat history — the Claude.ai and ChatGPT data-export
// zips — into real conversations of theirs. The work is the corpus's
// (tools/corpus/src/chat_import.py, behind `corpus__import_chat_export`): it
// parses the export, writes each thread as a conversation marked by its
// `origin` and stamped `imported_at`, and indexes it for search in the
// background. This file is the server's side of it, shared by the admin
// console (a member's page) and the app's settings (P4 of the domains'
// roadmap, 19 September 2026: "Import my conversations" lives there, not in
// the onboarding).
//
// What an import changes for the rest of the system: the sidebar badges the
// conversations by origin; the corpus searches them; the domains' night maps
// them like any conversation of the member's (they belong to no domain), and
// the briefs' night reads them once whole, whatever dates the export carries
// (`imported_at`, services/domainBriefs.ts).
import { mkdirSync } from "fs";
import { join } from "path";
import { getAppDir } from "../../lib/appDir";
import db from "../db";
import { corpusCall } from "./mcpClient";
import { getUser } from "./users";

export const IMPORT_PROVIDERS = ["anthropic", "chatgpt"] as const;
export type ImportProvider = (typeof IMPORT_PROVIDERS)[number];

export function isImportProvider(s: string): s is ImportProvider {
  return (IMPORT_PROVIDERS as readonly string[]).includes(s);
}

/** Where the uploaded exports land, under the app dir. */
export function uploadsDir(): string {
  const dir = join(getAppDir(), "uploads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface ImportDeps {
  /** The corpus tool call, scoped to the member. */
  call: (memberId: string, tool: string, args: any) => Promise<any>;
}

const defaultDeps: ImportDeps = { call: corpusCall };
let deps: ImportDeps = defaultDeps;
/** Tests swap the corpus for a stub. */
export function setImportDeps(d: Partial<ImportDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
}

export class ImportError extends Error {
  constructor(
    public code: "not_zip" | "corpus_unreachable",
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Save the export and start the import in the corpus; answers with the
 *  job to poll. Only a `.zip` is accepted — it is what both providers hand
 *  out, and the importer reads nothing else from a member. */
export async function startImport(memberId: string, provider: ImportProvider, file: File): Promise<{ job_id: string; provider: string }> {
  if (!file.name.toLowerCase().endsWith(".zip")) throw new ImportError("not_zip");
  const dest = join(uploadsDir(), `${provider}-${memberId}-${Date.now()}.zip`);
  await Bun.write(dest, file);
  try {
    return await deps.call(memberId, "import_chat_export", { path: dest, provider, member_id: memberId });
  } catch (e: any) {
    throw new ImportError("corpus_unreachable", e?.message);
  }
}

/** `{ phase, done, total, status, result | error }` for a job. */
export async function importStatus(memberId: string, jobId: string): Promise<any> {
  try {
    return await deps.call(memberId, "import_status", { job_id: jobId });
  } catch (e: any) {
    throw new ImportError("corpus_unreachable", e?.message);
  }
}

/** The member's runs for a provider, newest first, and the sync watermark. */
export async function importHistory(memberId: string, provider: ImportProvider): Promise<any> {
  try {
    return await deps.call(memberId, "import_history", { member_id: memberId, provider });
  } catch (e: any) {
    throw new ImportError("corpus_unreachable", e?.message);
  }
}

/** Whether the member has ever imported a history: a conversation of theirs
 *  carrying a provider as origin. Read by the everyday prompt, which may
 *  mention the import once to a member who never did it. */
export function hasImported(memberId: string): boolean {
  return !!db
    .query(`SELECT 1 FROM conversations WHERE user_id = ? AND origin IN ('anthropic', 'chatgpt') LIMIT 1`)
    .get(memberId);
}

/** One sentence of the everyday prompt, for a member who never imported: the
 *  design (4f) lets Maurice mention the import once, when it is relevant, and
 *  never sell it. "" for a guest, and once a history is in. Only the caller
 *  decides where it goes (services/claude.ts: the member's own conversation,
 *  never a room). */
export function importHintSection(memberId: string, memberName: string): string {
  const u = getUser(memberId);
  if (!u || u.role === "guest" || hasImported(memberId)) return "";
  return (
    `\n\nIf ${memberName} refers to past conversations they had with ChatGPT or Claude, or wonders whether you could know them, ` +
    `you may say once that the app's settings ("Import my conversations") take the data export of either and make those ` +
    `conversations part of what you remember. Do not bring it up otherwise, and never as a pitch.`
  );
}
