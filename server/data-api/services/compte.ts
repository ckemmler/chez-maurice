/**
 * Compte service — bank transactions from compte.db (SQLite).
 */

import { Database } from "bun:sqlite";
import { getDbPath } from "../lib/config";

const DB_PATH = getDbPath("compte.db");

let db: Database;
function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
  }
  return db;
}

export interface Transaction {
  id: number;
  sequence_number: string | null;
  execution_date: string;
  value_date: string | null;
  amount: number;
  counterparty_name: string | null;
  communication: string | null;
  details: string | null;
  import_month: string;
  import_year: number;
  notes: string | null;
  category: string | null;
  category_id: number | null;
}

export interface Category {
  id: number;
  name: string;
  display_order: number | null;
  is_ignored: boolean;
}

export function listTransactions(memberId: string, opts: {
  month?: string;
  year?: number;
  category?: string;
  uncategorized?: boolean;
  search?: string;
  since?: string;
  until?: string;
  limit?: number;
}): Transaction[] {
  const conditions: string[] = ["(t.member_id = $memberId OR t.scope = 'tenant')"];
  const params: Record<string, string | number> = { $memberId: memberId };

  if (opts.month) {
    conditions.push("t.import_month = $month");
    params.$month = opts.month;
  }
  if (opts.year) {
    conditions.push("t.import_year = $year");
    params.$year = opts.year;
  }
  if (opts.category) {
    conditions.push("c.name = $category");
    params.$category = opts.category;
  }
  if (opts.uncategorized) {
    conditions.push("t.category_id IS NULL");
  }
  if (opts.search) {
    conditions.push("(t.counterparty_name LIKE $search OR t.details LIKE $search OR t.communication LIKE $search)");
    params.$search = `%${opts.search}%`;
  }
  if (opts.since) {
    conditions.push("t.execution_date >= $since");
    params.$since = opts.since;
  }
  if (opts.until) {
    conditions.push("t.execution_date <= $until");
    params.$until = opts.until;
  }

  const limit = opts.limit ?? 200;
  const where = `WHERE ${conditions.join(" AND ")}`;
  const query = `
    SELECT t.id, t.sequence_number, t.execution_date, t.value_date,
           t.amount, t.counterparty_name, t.communication, t.details,
           t.import_month, t.import_year, t.notes, t.category_id,
           c.name as category
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    ${where}
    ORDER BY t.execution_date DESC, t.id DESC
    LIMIT $limit
  `;
  params.$limit = limit;

  return getDb().prepare(query).all(params) as Transaction[];
}

export function getTransaction(memberId: string, id: number): Transaction | null {
  return getDb().prepare(`
    SELECT t.*, c.name as category
    FROM transactions t LEFT JOIN categories c ON t.category_id = c.id
    WHERE t.id = $id AND (t.member_id = $memberId OR t.scope = 'tenant')
  `).get({ $id: id, $memberId: memberId }) as Transaction | null;
}

export function categorizeTransaction(memberId: string, id: number, categoryName: string): Transaction | null {
  const db = getDb();
  const cat = db.prepare("SELECT id FROM categories WHERE name = $name").get({ $name: categoryName }) as { id: number } | null;
  if (!cat) return null;

  db.prepare("UPDATE transactions SET category_id = $catId, category_confirmed = 1 WHERE id = $id AND member_id = $memberId").run({ $catId: cat.id, $id: id, $memberId: memberId });
  return getTransaction(memberId, id);
}

export function listCategories(excludeIgnored = false): Category[] {
  const query = excludeIgnored
    ? "SELECT id, name, display_order, is_ignored FROM categories WHERE is_ignored = 0 ORDER BY display_order"
    : "SELECT id, name, display_order, is_ignored FROM categories ORDER BY display_order";
  return getDb().prepare(query).all() as Category[];
}

export function monthlySummary(memberId: string, year = 2025): Array<{
  month: string;
  total_spent: number;
  total_income: number;
  tx_count: number;
  by_category: Array<{ category: string | null; count: number; total: number }>;
}> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT import_month as month,
           SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) as total_spent,
           SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as total_income,
           COUNT(*) as tx_count
    FROM transactions
    WHERE import_year = $year AND (member_id = $memberId OR scope = 'tenant')
    GROUP BY import_month
    ORDER BY MIN(execution_date)
  `).all({ $year: year, $memberId: memberId }) as Array<{ month: string; total_spent: number; total_income: number; tx_count: number }>;

  return rows.map((r) => {
    const cats = db.prepare(`
      SELECT c.name as category, COUNT(*) as count, SUM(t.amount) as total
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.import_month = $month AND t.import_year = $year AND (t.member_id = $memberId OR t.scope = 'tenant')
      GROUP BY c.name ORDER BY total ASC
    `).all({ $month: r.month, $year: year, $memberId: memberId }) as Array<{ category: string | null; count: number; total: number }>;
    return { ...r, by_category: cats };
  });
}

export function categoryBreakdown(memberId: string, opts: { month?: string; year?: number }): Array<{ category: string | null; count: number; total: number }> {
  const conditions: string[] = ["(t.member_id = $memberId OR t.scope = 'tenant')"];
  const params: Record<string, string | number> = { $memberId: memberId };

  if (opts.month) {
    conditions.push("t.import_month = $month");
    params.$month = opts.month;
  }
  if (opts.year) {
    conditions.push("t.import_year = $year");
    params.$year = opts.year;
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  return getDb().prepare(`
    SELECT c.name as category, COUNT(*) as count, SUM(t.amount) as total
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    ${where}
    GROUP BY c.name ORDER BY total ASC
  `).all(params) as Array<{ category: string | null; count: number; total: number }>;
}

export function transactionsForDate(memberId: string, dateStr: string): Transaction[] {
  return getDb().prepare(`
    SELECT t.id, t.execution_date, t.amount, t.counterparty_name,
           t.details, t.communication, t.category_id,
           c.name as category
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    WHERE t.execution_date = $date AND (t.member_id = $memberId OR t.scope = 'tenant')
    ORDER BY t.amount ASC
  `).all({ $date: dateStr, $memberId: memberId }) as Transaction[];
}
