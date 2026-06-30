/**
 * Tasks service — SQLite-backed task management.
 *
 * Tables: tasks, task_log, task_categories (all in akita.db).
 */

import { Database } from "bun:sqlite";
import { getDbPath } from "../lib/config";

const DB_PATH = getDbPath("akita.db");

let db: Database;
function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
  }
  return db;
}

let dbWrite: Database;
function getWriteDb(): Database {
  if (!dbWrite) {
    dbWrite = new Database(DB_PATH);
    dbWrite.exec("PRAGMA journal_mode=WAL");
  }
  return dbWrite;
}

// ── Schema init ──

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'inbox',
  due TEXT,
  do_date TEXT,
  do_date_reason TEXT,
  estimated_duration INTEGER,
  recurrence TEXT,
  tags_json TEXT,
  defer_count INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT REFERENCES tasks(id),
  link_type TEXT,
  waiting_since TEXT,
  review_note TEXT,
  actual_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  dropped_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_do_date ON tasks(do_date);

CREATE TABLE IF NOT EXISTS task_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  status TEXT NOT NULL,
  at TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_log_task_at ON task_log(task_id, at);

CREATE TABLE IF NOT EXISTS task_categories (
  name TEXT PRIMARY KEY,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

let schemaReady = false;
function ensureSchema(): void {
  if (schemaReady) return;
  getWriteDb().exec(SCHEMA_SQL);
  schemaReady = true;
}

// ── Types ──

export interface Task {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  status: string;
  due: string | null;
  do_date: string | null;
  do_date_reason: string | null;
  estimated_duration: number | null;
  recurrence: string | null;
  tags: string[];
  defer_count: number;
  parent_id: string | null;
  link_type: string | null;
  waiting_since: string | null;
  review_note: string | null;
  actual_started_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  dropped_at: string | null;
  log?: TaskLogEntry[];
}

export interface TaskLogEntry {
  status: string;
  at: string;
  note: string | null;
}

export interface TaskCategory {
  name: string;
  description: string;
  task_count?: number;
}

// ── Helpers ──

function now(): string {
  return new Date().toISOString();
}

function rowToTask(row: any): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    status: row.status,
    due: row.due,
    do_date: row.do_date,
    do_date_reason: row.do_date_reason,
    estimated_duration: row.estimated_duration,
    recurrence: row.recurrence,
    tags: row.tags_json ? JSON.parse(row.tags_json) : [],
    defer_count: row.defer_count,
    parent_id: row.parent_id,
    link_type: row.link_type,
    waiting_since: row.waiting_since,
    review_note: row.review_note,
    actual_started_at: row.actual_started_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    dropped_at: row.dropped_at,
  };
}

function addLog(taskId: string, status: string, note: string | null = null): void {
  getWriteDb()
    .prepare("INSERT INTO task_log (task_id, status, at, note) VALUES (?, ?, ?, ?)")
    .run(taskId, status, now(), note);
}

function getLogForTask(taskId: string): TaskLogEntry[] {
  return getDb()
    .prepare("SELECT status, at, note FROM task_log WHERE task_id = ? ORDER BY at ASC")
    .all(taskId) as TaskLogEntry[];
}

// ── CRUD ──

export interface ListTasksOpts {
  status?: string;
  category?: string;
  dueBefore?: string;
  dueAfter?: string;
  overdueOnly?: boolean;
  limit?: number;
}

export function listTasks(memberId: string, opts: ListTasksOpts): Task[] {
  ensureSchema();
  const conditions: string[] = ["member_id = ?"];
  const params: any[] = [memberId];

  if (opts.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  if (opts.category) {
    conditions.push("category = ?");
    params.push(opts.category);
  }
  if (opts.dueBefore) {
    conditions.push("due <= ?");
    params.push(opts.dueBefore);
  }
  if (opts.dueAfter) {
    conditions.push("due >= ?");
    params.push(opts.dueAfter);
  }
  if (opts.overdueOnly) {
    conditions.push("due < ?");
    params.push(now());
    if (!opts.status) {
      conditions.push("status IN ('inbox', 'active')");
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit || 100;

  const rows = getDb()
    .prepare(`SELECT * FROM tasks ${where} ORDER BY due ASC, created_at DESC LIMIT ?`)
    .all(...params, limit);

  return rows.map(rowToTask);
}

export function getTask(memberId: string, id: string): Task | null {
  ensureSchema();
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ? AND member_id = ?").get(id, memberId);
  if (!row) return null;
  const task = rowToTask(row);
  task.log = getLogForTask(id);
  return task;
}

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  category?: string | null;
  status?: string;
  due?: string | null;
  do_date?: string | null;
  do_date_reason?: string | null;
  estimated_duration?: number | null;
  recurrence?: string | null;
  tags?: string[];
  parent_id?: string | null;
  link_type?: string | null;
}

export function createTask(memberId: string, input: CreateTaskInput): Task {
  ensureSchema();
  const id = crypto.randomUUID();
  const ts = now();
  const initialStatus = input.status || "inbox";

  const wdb = getWriteDb();
  wdb.transaction(() => {
    wdb.prepare(`
      INSERT INTO tasks (id, member_id, title, description, category, status, due, do_date, do_date_reason,
        estimated_duration, recurrence, tags_json, defer_count, parent_id, link_type,
        waiting_since, review_note, actual_started_at, created_at, updated_at,
        completed_at, dropped_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)
    `).run(
      id,
      memberId,
      input.title,
      input.description ?? null,
      input.category ?? null,
      initialStatus,
      input.due ?? null,
      input.do_date ?? null,
      input.do_date_reason ?? null,
      input.estimated_duration ?? null,
      input.recurrence ?? null,
      JSON.stringify(input.tags || []),
      input.parent_id ?? null,
      input.link_type || (input.parent_id ? "followup" : null),
      initialStatus === "waiting" ? ts : null,
      ts,
      ts,
    );
    addLog(id, initialStatus);
  })();

  return getTask(memberId, id)!;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  category?: string;
  status?: string;
  tags?: string[];
  recurrence?: string;
  do_date_reason?: string;
  review_note?: string;
  estimated_duration?: number;
  due?: string | null;
  do_date?: string | null;
  actual_started_at?: string | null;
}

export function updateTask(memberId: string, id: string, input: UpdateTaskInput): Task | null {
  ensureSchema();
  const ts = now();
  const sets: string[] = ["updated_at = ?"];
  const params: any[] = [ts];

  for (const key of [
    "title", "description", "category", "status", "recurrence",
    "do_date_reason", "review_note",
  ] as const) {
    if ((input as any)[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push((input as any)[key]);
    }
  }
  if (input.estimated_duration !== undefined) {
    sets.push("estimated_duration = ?");
    params.push(input.estimated_duration);
  }
  if (input.tags !== undefined) {
    sets.push("tags_json = ?");
    params.push(JSON.stringify(input.tags));
  }
  if (input.due !== undefined) {
    sets.push("due = ?");
    params.push(input.due);
  }
  if (input.do_date !== undefined) {
    sets.push("do_date = ?");
    params.push(input.do_date);
  }
  if (input.actual_started_at !== undefined) {
    sets.push("actual_started_at = ?");
    params.push(input.actual_started_at);
  }
  if (input.status !== undefined) {
    if (input.status === "waiting") {
      sets.push("waiting_since = ?");
      params.push(ts);
    } else {
      sets.push("waiting_since = NULL");
    }
  }

  params.push(id, memberId);

  const wdb = getWriteDb();
  const result = wdb.transaction(() => {
    const changes = wdb
      .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND member_id = ?`)
      .run(...params);
    if (changes.changes === 0) return null;
    if (input.status !== undefined) {
      addLog(id, input.status);
    }
    return getTask(memberId, id);
  })();

  return result;
}

export function completeTask(
  memberId: string,
  id: string,
  opts: { note?: string; next_action?: string; next_action_due?: string; next_action_status?: string } = {},
): { completed: Task; next: Task | null; next_task: Task | null } | null {
  ensureSchema();
  const ts = now();
  const wdb = getWriteDb();

  return wdb.transaction(() => {
    const existing = getDb().prepare("SELECT * FROM tasks WHERE id = ? AND member_id = ?").get(id, memberId);
    if (!existing) return null;

    wdb.prepare(`
      UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ?, waiting_since = NULL
      WHERE id = ? AND member_id = ?
    `).run(ts, ts, id, memberId);
    addLog(id, "done", opts.note || null);

    const completed = getTask(memberId, id)!;
    let next: Task | null = null;
    let nextTask: Task | null = null;

    // Auto-recurrence
    if ((existing as any).recurrence) {
      const nextDue = computeNextDue((existing as any).due, (existing as any).recurrence);
      next = createTask(memberId, {
        title: (existing as any).title,
        description: (existing as any).description,
        category: (existing as any).category,
        status: "inbox",
        due: nextDue,
        estimated_duration: (existing as any).estimated_duration,
        recurrence: (existing as any).recurrence,
        tags: (existing as any).tags_json ? JSON.parse((existing as any).tags_json) : [],
      });
    }

    // Follow-up chain
    if (opts.next_action) {
      const followUpStatus = opts.next_action_status || "active";
      nextTask = createTask(memberId, {
        title: opts.next_action,
        category: (existing as any).category,
        status: followUpStatus,
        due: opts.next_action_due || null,
        do_date: (existing as any).do_date || ts.slice(0, 10),
        do_date_reason: "Suite de : " + ((existing as any).title || "").slice(0, 60),
        tags: (existing as any).tags_json ? JSON.parse((existing as any).tags_json) : [],
        parent_id: id,
        link_type: "followup",
      });
    }

    return { completed, next, next_task: nextTask };
  })();
}

export function dropTask(memberId: string, id: string, reason?: string): Task | null {
  ensureSchema();
  const ts = now();
  const wdb = getWriteDb();

  return wdb.transaction(() => {
    const changes = wdb
      .prepare("UPDATE tasks SET status = 'dropped', dropped_at = ?, updated_at = ? WHERE id = ? AND member_id = ?")
      .run(ts, ts, id, memberId);
    if (changes.changes === 0) return null;
    addLog(id, "dropped", reason || null);
    return getTask(memberId, id)!;
  })();
}

export function deferTask(memberId: string, id: string, opts: { due?: string; note?: string } = {}): Task | null {
  ensureSchema();
  const ts = now();
  const wdb = getWriteDb();

  return wdb.transaction(() => {
    const sets = ["updated_at = ?", "defer_count = defer_count + 1"];
    const params: any[] = [ts];

    if (opts.due) {
      sets.push("due = ?");
      params.push(opts.due);
    }
    params.push(id, memberId);

    const changes = wdb
      .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND member_id = ?`)
      .run(...params);
    if (changes.changes === 0) return null;
    addLog(id, "deferred", opts.note || null);
    return getTask(memberId, id)!;
  })();
}

// ── Chain traversal ──

export function getTaskChain(memberId: string, id: string): { chain: (Task & { chain_position: string; chain_root_title: string })[]; root_title: string; total_steps: number } | null {
  ensureSchema();
  const task = getDb().prepare("SELECT * FROM tasks WHERE id = ? AND member_id = ?").get(id, memberId);
  if (!task) return null;

  // Walk up to root
  let root = task as any;
  while (root.parent_id) {
    const parent = getDb().prepare("SELECT * FROM tasks WHERE id = ? AND member_id = ?").get(root.parent_id, memberId);
    if (!parent) break;
    root = parent;
  }

  // Walk down from root
  const chain: any[] = [root];
  let currentIds = [root.id];
  while (true) {
    const placeholders = currentIds.map(() => "?").join(",");
    const children = getDb()
      .prepare(`SELECT * FROM tasks WHERE parent_id IN (${placeholders}) AND member_id = ? ORDER BY created_at ASC`)
      .all(...currentIds, memberId);
    if (!children.length) break;
    chain.push(...children);
    currentIds = children.map((c: any) => c.id);
  }

  const total = chain.length;
  const rootTitle = (root as any).title;
  const result = chain.map((row, i) => ({
    ...rowToTask(row),
    chain_position: `step ${i + 1} of ${total}`,
    chain_root_title: rootTitle,
  }));

  return { chain: result, root_title: rootTitle, total_steps: total };
}

// ── Triage ──

export function getTriageData(memberId: string): {
  inbox: Task[];
  overdue: Task[];
  due_today: Task[];
  waiting: Task[];
  stale_waiting: Task[];
  frequently_deferred: Task[];
} {
  ensureSchema();
  const db = getDb();
  const timestamp = now();
  const today = timestamp.slice(0, 10);
  const tomorrow = new Date(new Date(today).getTime() + 86400000).toISOString().slice(0, 10);
  const staleThreshold = new Date(Date.now() - 7 * 86400000).toISOString();

  const inbox = db
    .prepare("SELECT * FROM tasks WHERE member_id = ? AND status = 'inbox' ORDER BY created_at DESC")
    .all(memberId)
    .map(rowToTask);

  const overdue = db
    .prepare("SELECT * FROM tasks WHERE member_id = ? AND due < ? AND status IN ('inbox', 'active') ORDER BY due ASC")
    .all(memberId, timestamp)
    .map(rowToTask);

  const dueToday = db
    .prepare("SELECT * FROM tasks WHERE member_id = ? AND due >= ? AND due < ? AND status IN ('inbox', 'active') ORDER BY due ASC")
    .all(memberId, today, tomorrow)
    .map(rowToTask);

  const frequentlyDeferred = db
    .prepare("SELECT * FROM tasks WHERE member_id = ? AND defer_count >= 3 AND status IN ('inbox', 'active') ORDER BY defer_count DESC")
    .all(memberId)
    .map(rowToTask);

  const waiting = db
    .prepare("SELECT * FROM tasks WHERE member_id = ? AND status = 'waiting' ORDER BY waiting_since ASC")
    .all(memberId)
    .map(rowToTask);

  const staleWaiting = db
    .prepare("SELECT * FROM tasks WHERE member_id = ? AND status = 'waiting' AND waiting_since IS NOT NULL AND waiting_since <= ? ORDER BY waiting_since ASC")
    .all(memberId, staleThreshold)
    .map(rowToTask);

  // Enrich with chain root title where applicable
  function enrichWithChainRoot(tasks: Task[]): Task[] {
    return tasks.map((t) => {
      if (t.parent_id) {
        let root: any = db.prepare("SELECT * FROM tasks WHERE id = ? AND member_id = ?").get(t.parent_id, memberId);
        if (root) {
          while (root.parent_id) {
            const parent = db.prepare("SELECT * FROM tasks WHERE id = ? AND member_id = ?").get(root.parent_id, memberId);
            if (!parent) break;
            root = parent;
          }
          (t as any).chain_root_title = root.title;
        }
      }
      return t;
    });
  }

  return {
    inbox: enrichWithChainRoot(inbox),
    overdue: enrichWithChainRoot(overdue),
    due_today: enrichWithChainRoot(dueToday),
    waiting: enrichWithChainRoot(waiting),
    stale_waiting: enrichWithChainRoot(staleWaiting),
    frequently_deferred: enrichWithChainRoot(frequentlyDeferred),
  };
}

// ── Stats ──

export function getStats(memberId: string, days: number = 30): { days: number; stats: Record<string, Record<string, number>> } {
  ensureSchema();
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const rows = getDb()
    .prepare(`
      SELECT COALESCE(category, 'uncategorized') as cat, status, COUNT(*) as count
      FROM tasks
      WHERE member_id = ? AND updated_at >= ?
      GROUP BY category, status
    `)
    .all(memberId, since) as { cat: string; status: string; count: number }[];

  const stats: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    if (!stats[r.cat]) stats[r.cat] = {};
    stats[r.cat][r.status] = r.count;
  }

  return { days, stats };
}

// ── Categories ──

const PREDEFINED_CATEGORIES = [
  { name: "work", description: "Professional work" },
  { name: "maurice", description: "Maurice project" },
  { name: "writing-pro", description: "Professional writing" },
  { name: "writing-personal", description: "Personal writing" },
  { name: "violin", description: "Violin practice" },
  { name: "household", description: "Household tasks" },
  { name: "kids-school", description: "Kids school" },
  { name: "kids-fun", description: "Kids fun activities" },
  { name: "entertainment", description: "Entertainment" },
  { name: "health", description: "Health & wellness" },
  { name: "admin", description: "Administrative tasks" },
  { name: "social", description: "Social & relationships" },
];

function ensurePredefinedCategories(): void {
  const wdb = getWriteDb();
  const count = getDb().prepare("SELECT COUNT(*) as c FROM task_categories").get() as { c: number };
  if (count.c === 0) {
    const insert = wdb.prepare(
      "INSERT OR IGNORE INTO task_categories (name, description) VALUES (?, ?)",
    );
    wdb.transaction(() => {
      for (const cat of PREDEFINED_CATEGORIES) {
        insert.run(cat.name, cat.description);
      }
    })();
  }
}

export function listCategories(): TaskCategory[] {
  ensureSchema();
  ensurePredefinedCategories();

  const db = getDb();
  const cats = db
    .prepare("SELECT name, description FROM task_categories ORDER BY name")
    .all() as { name: string; description: string }[];

  const counts = db
    .prepare(`
      SELECT COALESCE(category, 'uncategorized') as cat, COUNT(*) as count
      FROM tasks
      WHERE status IN ('inbox', 'active')
      GROUP BY category
    `)
    .all() as { cat: string; count: number }[];

  const countMap: Record<string, number> = {};
  for (const c of counts) countMap[c.cat] = c.count;

  return cats.map((cat) => ({
    name: cat.name,
    description: cat.description || "",
    task_count: countMap[cat.name] || 0,
  }));
}

export function createCategory(name: string, description?: string): { created: string } | { error: string } {
  ensureSchema();
  const existing = getDb().prepare("SELECT name FROM task_categories WHERE name = ?").get(name);
  if (existing) return { error: "Category already exists" };

  getWriteDb()
    .prepare("INSERT INTO task_categories (name, description) VALUES (?, ?)")
    .run(name, description || "");

  return { created: name };
}

export function renameCategory(
  oldName: string,
  newName: string,
  description?: string,
): { renamed: string; to: string } | { error: string } {
  ensureSchema();
  const wdb = getWriteDb();

  return wdb.transaction(() => {
    const existing = getDb().prepare("SELECT name FROM task_categories WHERE name = ?").get(oldName);
    if (!existing) return { error: "Category not found" };

    if (description !== undefined) {
      wdb.prepare("UPDATE task_categories SET name = ?, description = ? WHERE name = ?").run(newName, description, oldName);
    } else {
      wdb.prepare("UPDATE task_categories SET name = ? WHERE name = ?").run(newName, oldName);
    }
    wdb.prepare("UPDATE tasks SET category = ?, updated_at = ? WHERE category = ?").run(newName, now(), oldName);

    return { renamed: oldName, to: newName };
  })();
}

export function deleteCategory(
  name: string,
  reassign: string | null = null,
): { deleted: string; reassigned_to: string | null } | { error: string } {
  ensureSchema();
  const wdb = getWriteDb();

  return wdb.transaction(() => {
    const changes = wdb.prepare("DELETE FROM task_categories WHERE name = ?").run(name);
    if (changes.changes === 0) return { error: "Category not found" };

    wdb.prepare("UPDATE tasks SET category = ?, updated_at = ? WHERE category = ?").run(reassign, now(), name);

    return { deleted: name, reassigned_to: reassign };
  })();
}

// ── Recurrence helper ──

function computeNextDue(currentDue: string | null, recurrence: string): string | null {
  const base = currentDue ? new Date(currentDue) : new Date();
  const r = recurrence.toLowerCase();

  if (r.includes("daily") || r.includes("every day")) {
    return new Date(base.getTime() + 86400000).toISOString();
  }
  if (r.includes("weekly") || r.includes("every week")) {
    return new Date(base.getTime() + 7 * 86400000).toISOString();
  }
  if (r.includes("monthly") || r.includes("every month")) {
    const d = new Date(base);
    d.setMonth(d.getMonth() + 1);
    return d.toISOString();
  }
  if (r.includes("monday")) return nextWeekday(base, 1).toISOString();
  if (r.includes("tuesday")) return nextWeekday(base, 2).toISOString();
  if (r.includes("wednesday")) return nextWeekday(base, 3).toISOString();
  if (r.includes("thursday")) return nextWeekday(base, 4).toISOString();
  if (r.includes("friday")) return nextWeekday(base, 5).toISOString();
  if (r.includes("saturday")) return nextWeekday(base, 6).toISOString();
  if (r.includes("sunday")) return nextWeekday(base, 0).toISOString();

  return new Date(base.getTime() + 7 * 86400000).toISOString();
}

function nextWeekday(from: Date, day: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + ((day - d.getDay() + 7) % 7 || 7));
  return d;
}
