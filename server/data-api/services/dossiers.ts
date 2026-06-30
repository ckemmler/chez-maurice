/**
 * Dossier service — reads dossier metadata from akita.db (SQLite, readonly)
 * and markdown content from the filesystem.
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { getDbPath } from "../lib/config";

const DB_PATH = getDbPath("akita.db");
const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const DOSSIER_ROOT = resolve(repoRoot, "dossiers");

function getDb(): Database | null {
  if (!existsSync(DB_PATH)) return null;
  // Note: can't use readonly:true — WAL-mode DBs need write access for WAL file
  return new Database(DB_PATH);
}

// Run migrations on module load
function migrateBriefingTopics(): void {
  const db = getDb();
  if (!db) return;
  try {
    const cols = db.query("PRAGMA table_info(briefing_topics)").all() as Array<{ name: string }>;
    if (cols.length === 0) return; // table doesn't exist yet
    const existing = new Set(cols.map(c => c.name));
    if (!existing.has("extract_articles")) {
      db.query("ALTER TABLE briefing_topics ADD COLUMN extract_articles INTEGER NOT NULL DEFAULT 1").run();
    }
    if (!existing.has("extract_videos")) {
      db.query("ALTER TABLE briefing_topics ADD COLUMN extract_videos INTEGER NOT NULL DEFAULT 1").run();
    }
    if (!existing.has("extract_podcasts")) {
      db.query("ALTER TABLE briefing_topics ADD COLUMN extract_podcasts INTEGER NOT NULL DEFAULT 1").run();
    }
    if (!existing.has("extract_books")) {
      db.query("ALTER TABLE briefing_topics ADD COLUMN extract_books INTEGER NOT NULL DEFAULT 0").run();
    }
    if (!existing.has("run_synthesis")) {
      db.query("ALTER TABLE briefing_topics ADD COLUMN run_synthesis INTEGER NOT NULL DEFAULT 1").run();
    }
    if (!existing.has("max_age_days")) {
      db.query("ALTER TABLE briefing_topics ADD COLUMN max_age_days INTEGER NOT NULL DEFAULT 7").run();
    }
    if (!existing.has("analysis_brief")) {
      db.query("ALTER TABLE briefing_topics ADD COLUMN analysis_brief TEXT").run();
    }
    if (!existing.has("analysis_brief_updated_at")) {
      db.query("ALTER TABLE briefing_topics ADD COLUMN analysis_brief_updated_at TEXT").run();
    }
    if (!existing.has("schedule_days")) {
      db.query("ALTER TABLE briefing_topics ADD COLUMN schedule_days TEXT NOT NULL DEFAULT '1,2,3,4,5,6,7'").run();
    }
  } finally {
    db.close();
  }
}
migrateBriefingTopics();

function readContent(contentPath: string): string {
  const full = resolve(DOSSIER_ROOT, contentPath);
  try {
    return readFileSync(full, "utf8");
  } catch {
    return "";
  }
}

// ── Types ──

export interface DossierRow {
  id: string;
  type: string;
  title: string;
  content_path: string;
  parent_id: string | null;
  source_request_id: string | null;
  briefing_topic_id: string | null;
  period_interval: string | null;
  period_start: string | null;
  period_end: string | null;
  corpus_hits: number;
  web_sources_used: number;
  stats_json: string | null;
  tokens_used: number;
  cost_usd: number;
  created_at: string;
}

export interface ResonanceRow {
  id: number;
  dossier_id: string;
  note_id: string;
  note_excerpt: string;
  connection_rationale: string;
  relevance_score: number;
  source_type: string | null;
  created_at: string;
}

export interface FollowUpRow {
  id: number;
  dossier_id: string;
  question: string;
}

export interface BriefingTopicRow {
  id: string;
  name: string;
  description: string;
  format: string;
  active: number;
  search_queries_json: string;
  web_provider: string | null;
  llm_model: string | null;
  extract_articles: number;
  extract_videos: number;
  extract_podcasts: number;
  extract_books: number;
  run_synthesis: number;
  max_age_days: number;
  analysis_brief: string | null;
  analysis_brief_updated_at: string | null;
  schedule_days: string;
  created_at: string;
  updated_at: string;
}

export interface ResearchRequestRow {
  id: string;
  command: string;
  parent_id: string | null;
  triggering_annotation: string | null;
  status: string;
  dossier_id: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  metadata_json: string | null;
}

// ── Dossiers ──

export function getDossier(
  memberId: string,
  id: string,
): (DossierRow & { content: string; research_log: string; resonances: ResonanceRow[]; follow_ups: string[] }) | null {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db.query("SELECT * FROM dossiers WHERE id = ? AND (member_id = ? OR scope = 'tenant')").get(id, memberId) as DossierRow | null;
    if (!row) return null;
    const content = readContent(row.content_path);
    // Load sibling research.md log
    const contentDir = resolve(DOSSIER_ROOT, row.content_path, "..");
    const researchLogPath = resolve(contentDir, "research.md");
    let researchLog = "";
    try { researchLog = readFileSync(researchLogPath, "utf8"); } catch { /* may not exist */ }
    const resonances = db
      .query("SELECT * FROM resonances WHERE dossier_id = ? AND (member_id = ? OR scope = 'tenant') ORDER BY relevance_score DESC")
      .all(id, memberId) as ResonanceRow[];
    const followUps = db
      .query("SELECT question FROM dossier_follow_ups WHERE dossier_id = ?")
      .all(id) as { question: string }[];
    // Fetch the original command/prompt from the research request
    let command: string | null = null;
    if (row.source_request_id) {
      const req = db
        .query("SELECT command FROM deep_research_requests WHERE id = ?")
        .get(row.source_request_id) as { command: string } | null;
      if (req) command = req.command;
    }
    return {
      ...row,
      content,
      research_log: researchLog,
      resonances,
      follow_ups: followUps.map((f) => f.question),
      command,
    };
  } finally {
    db.close();
  }
}

export function listDossiers(memberId: string, opts?: {
  type?: string;
  limit?: number;
  since?: string;
}): DossierRow[] {
  const db = getDb();
  if (!db) return [];
  try {
    const conditions: string[] = ["(member_id = ? OR scope = 'tenant')"];
    const params: any[] = [memberId];
    if (opts?.type) {
      conditions.push("type = ?");
      params.push(opts.type);
    }
    if (opts?.since) {
      conditions.push("created_at >= ?");
      params.push(opts.since);
    }
    let query = "SELECT * FROM dossiers WHERE " + conditions.join(" AND ");
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(opts?.limit ?? 20);
    return db.query(query).all(...params) as DossierRow[];
  } finally {
    db.close();
  }
}

export function getDossierTree(memberId: string, id: string): {
  dossier: DossierRow | null;
  parents: DossierRow[];
  children: DossierRow[];
} {
  const db = getDb();
  if (!db) return { dossier: null, parents: [], children: [] };
  try {
    const dossier = db.query("SELECT * FROM dossiers WHERE id = ? AND (member_id = ? OR scope = 'tenant')").get(id, memberId) as DossierRow | null;
    if (!dossier) return { dossier: null, parents: [], children: [] };

    // Walk up parent chain
    const parents: DossierRow[] = [];
    let currentId = dossier.parent_id;
    while (currentId) {
      const parent = db.query("SELECT * FROM dossiers WHERE id = ? AND (member_id = ? OR scope = 'tenant')").get(currentId, memberId) as DossierRow | null;
      if (!parent) break;
      parents.push(parent);
      currentId = parent.parent_id;
    }
    parents.reverse();

    const children = db
      .query("SELECT * FROM dossiers WHERE parent_id = ? AND (member_id = ? OR scope = 'tenant') ORDER BY created_at")
      .all(id, memberId) as DossierRow[];

    return { dossier, parents, children };
  } finally {
    db.close();
  }
}

export function deleteDossier(memberId: string, id: string): boolean {
  const db = getDb();
  if (!db) return false;
  try {
    // Get content_path before deleting (owner-only)
    const row = db.query("SELECT content_path FROM dossiers WHERE id = ? AND member_id = ?").get(id, memberId) as { content_path: string } | null;
    if (!row) return false;

    // Delete from DB (resonances, dossier_follow_ups, dossier_recommendations cascade via ON DELETE CASCADE)
    db.query("DELETE FROM dossiers WHERE id = ? AND member_id = ?").run(id, memberId);

    // Remove markdown file from disk
    const fullPath = resolve(DOSSIER_ROOT, row.content_path);
    try { unlinkSync(fullPath); } catch { /* file may not exist */ }

    return true;
  } finally {
    db.close();
  }
}

// ── Resonances ──

export function getResonances(memberId: string, dossierId: string): ResonanceRow[] {
  const db = getDb();
  if (!db) return [];
  try {
    return db
      .query("SELECT * FROM resonances WHERE dossier_id = ? AND (member_id = ? OR scope = 'tenant') ORDER BY relevance_score DESC")
      .all(dossierId, memberId) as ResonanceRow[];
  } finally {
    db.close();
  }
}

// ── Briefing Topics ──

export function getBriefingTopicNames(memberId: string): Record<string, string> {
  const db = getDb();
  if (!db) return {};
  try {
    const rows = db
      .query("SELECT id, name FROM briefing_topics WHERE member_id = ?")
      .all(memberId) as Array<{ id: string; name: string }>;
    const map: Record<string, string> = {};
    for (const r of rows) map[r.id] = r.name;
    return map;
  } finally {
    db.close();
  }
}

export function listBriefingTopics(memberId: string): Array<
  Omit<BriefingTopicRow, "search_queries_json"> & { search_queries: string[] }
> {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = db
      .query("SELECT * FROM briefing_topics WHERE member_id = ? ORDER BY name")
      .all(memberId) as BriefingTopicRow[];
    return rows.map((r) => {
      const { search_queries_json, ...rest } = r;
      return {
        ...rest,
        search_queries: JSON.parse(search_queries_json || "[]"),
        web_provider: r.web_provider ?? null,
        llm_model: r.llm_model ?? null,
        extract_articles: r.extract_articles ?? 1,
        extract_videos: r.extract_videos ?? 1,
        extract_podcasts: r.extract_podcasts ?? 1,
        extract_books: r.extract_books ?? 0,
        run_synthesis: r.run_synthesis ?? 1,
        max_age_days: r.max_age_days ?? 7,
        analysis_brief: r.analysis_brief ?? null,
        analysis_brief_updated_at: r.analysis_brief_updated_at ?? null,
        schedule_days: r.schedule_days ?? "1,2,3,4,5,6,7",
      };
    });
  } finally {
    db.close();
  }
}

export function createBriefingTopic(memberId: string, opts: {
  name: string;
  description: string;
  format?: string;
  search_queries?: string[];
  web_provider?: string | null;
  llm_model?: string | null;
  extract_articles?: boolean;
  extract_videos?: boolean;
  extract_podcasts?: boolean;
  extract_books?: boolean;
  run_synthesis?: boolean;
  max_age_days?: number;
  schedule_days?: string;
}): string {
  const db = getDb();
  if (!db) throw new Error("Database not available");
  try {
    const id = ulid();
    db.query(
      `INSERT INTO briefing_topics (id, member_id, name, description, format, search_queries_json, web_provider, llm_model,
        extract_articles, extract_videos, extract_podcasts, extract_books, run_synthesis, max_age_days, schedule_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      memberId,
      opts.name,
      opts.description,
      opts.format || "long_form",
      JSON.stringify(opts.search_queries || []),
      opts.web_provider || null,
      opts.llm_model || null,
      opts.extract_articles !== false ? 1 : 0,
      opts.extract_videos !== false ? 1 : 0,
      opts.extract_podcasts !== false ? 1 : 0,
      opts.extract_books ? 1 : 0,
      opts.run_synthesis !== false ? 1 : 0,
      opts.max_age_days ?? 7,
      opts.schedule_days ?? "1,2,3,4,5,6,7",
    );
    return id;
  } finally {
    db.close();
  }
}

export function updateBriefingTopic(
  memberId: string,
  id: string,
  updates: {
    name?: string; description?: string; format?: string; active?: boolean;
    search_queries?: string[]; web_provider?: string | null; llm_model?: string | null;
    extract_articles?: boolean; extract_videos?: boolean; extract_podcasts?: boolean;
    extract_books?: boolean; run_synthesis?: boolean; max_age_days?: number;
    analysis_brief?: string | null; schedule_days?: string;
  },
): void {
  const db = getDb();
  if (!db) throw new Error("Database not available");
  try {
    const fields: string[] = [];
    const params: any[] = [];
    if (updates.name !== undefined) { fields.push("name = ?"); params.push(updates.name); }
    if (updates.description !== undefined) { fields.push("description = ?"); params.push(updates.description); }
    if (updates.format !== undefined) { fields.push("format = ?"); params.push(updates.format); }
    if (updates.active !== undefined) { fields.push("active = ?"); params.push(updates.active ? 1 : 0); }
    if (updates.search_queries !== undefined) { fields.push("search_queries_json = ?"); params.push(JSON.stringify(updates.search_queries)); }
    if (updates.web_provider !== undefined) { fields.push("web_provider = ?"); params.push(updates.web_provider || null); }
    if (updates.llm_model !== undefined) { fields.push("llm_model = ?"); params.push(updates.llm_model || null); }
    if (updates.extract_articles !== undefined) { fields.push("extract_articles = ?"); params.push(updates.extract_articles ? 1 : 0); }
    if (updates.extract_videos !== undefined) { fields.push("extract_videos = ?"); params.push(updates.extract_videos ? 1 : 0); }
    if (updates.extract_podcasts !== undefined) { fields.push("extract_podcasts = ?"); params.push(updates.extract_podcasts ? 1 : 0); }
    if (updates.extract_books !== undefined) { fields.push("extract_books = ?"); params.push(updates.extract_books ? 1 : 0); }
    if (updates.run_synthesis !== undefined) { fields.push("run_synthesis = ?"); params.push(updates.run_synthesis ? 1 : 0); }
    if (updates.max_age_days !== undefined) { fields.push("max_age_days = ?"); params.push(updates.max_age_days); }
    if (updates.analysis_brief !== undefined) {
      fields.push("analysis_brief = ?"); params.push(updates.analysis_brief);
      fields.push("analysis_brief_updated_at = datetime('now')");
    }
    if (updates.schedule_days !== undefined) { fields.push("schedule_days = ?"); params.push(updates.schedule_days); }
    if (!fields.length) return;
    fields.push("updated_at = datetime('now')");
    params.push(id, memberId);
    db.query(`UPDATE briefing_topics SET ${fields.join(", ")} WHERE id = ? AND member_id = ?`).run(...params);
  } finally {
    db.close();
  }
}

export function deleteBriefingTopic(memberId: string, id: string): void {
  const db = getDb();
  if (!db) throw new Error("Database not available");
  try {
    db.query("DELETE FROM briefing_topics WHERE id = ? AND member_id = ?").run(id, memberId);
  } finally {
    db.close();
  }
}

/** Simple ULID generator (matches Python store). */
function ulid(): string {
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let ts = Date.now();
  const tsChars: string[] = [];
  for (let i = 0; i < 10; i++) { tsChars.push(chars[ts & 0x1f]); ts = Math.floor(ts / 32); }
  tsChars.reverse();
  const randChars: string[] = [];
  for (let i = 0; i < 16; i++) { randChars.push(chars[Math.floor(Math.random() * 32)]); }
  return tsChars.join("") + randChars.join("");
}

// ── Latest Briefing ──

export function getLatestBriefing(memberId: string, topicId: string): (DossierRow & { content: string }) | null {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db
      .query(
        "SELECT * FROM dossiers WHERE type = 'daily_briefing' AND briefing_topic_id = ? AND (member_id = ? OR scope = 'tenant') ORDER BY created_at DESC LIMIT 1",
      )
      .get(topicId, memberId) as DossierRow | null;
    if (!row) return null;
    return { ...row, content: readContent(row.content_path) };
  } finally {
    db.close();
  }
}

// ── Research Requests ──

export function listResearchRequests(memberId: string, opts?: {
  status?: string;
  limit?: number;
}): ResearchRequestRow[] {
  const db = getDb();
  if (!db) return [];
  try {
    const conditions: string[] = ["member_id = ?"];
    const params: any[] = [memberId];
    if (opts?.status) {
      conditions.push("status = ?");
      params.push(opts.status);
    }
    let query = "SELECT * FROM deep_research_requests WHERE " + conditions.join(" AND ");
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(opts?.limit ?? 20);
    return db.query(query).all(...params) as ResearchRequestRow[];
  } finally {
    db.close();
  }
}

export function getResearchRequest(memberId: string, id: string): ResearchRequestRow | null {
  const db = getDb();
  if (!db) return null;
  try {
    return db
      .query("SELECT * FROM deep_research_requests WHERE id = ? AND member_id = ?")
      .get(id, memberId) as ResearchRequestRow | null;
  } finally {
    db.close();
  }
}

