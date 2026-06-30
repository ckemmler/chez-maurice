import { Hono } from "hono";
import {
  listTransactions,
  getTransaction,
  categorizeTransaction,
  listCategories,
  monthlySummary,
  categoryBreakdown,
  transactionsForDate,
} from "../services/compte";

const app = new Hono();

// GET /transactions — list/filter
app.get("/transactions", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const q = c.req.query();
  const txs = listTransactions(memberId, {
    month: q.month,
    year: q.year ? parseInt(q.year) : undefined,
    category: q.category,
    uncategorized: q.uncategorized === "true",
    search: q.q || q.search,
    since: q.since,
    until: q.until,
    limit: q.limit ? parseInt(q.limit) : undefined,
  });
  return c.json({ transactions: txs, count: txs.length });
});

// GET /transactions/date/:date — transactions for a specific date
app.get("/transactions/date/:date", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const txs = transactionsForDate(memberId, c.req.param("date"));
  return c.json({ transactions: txs, count: txs.length });
});

// GET /transactions/:id — single transaction
app.get("/transactions/:id", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const tx = getTransaction(memberId, parseInt(c.req.param("id")));
  if (!tx) return c.json({ error: "Not found" }, 404);
  return c.json(tx);
});

// PUT /transactions/:id/categorize — assign category
app.put("/transactions/:id/categorize", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const body = await c.req.json<{ category: string }>();
  if (!body.category) return c.json({ error: "category is required" }, 400);

  const tx = categorizeTransaction(memberId, parseInt(c.req.param("id")), body.category);
  if (!tx) return c.json({ error: "Transaction or category not found" }, 404);
  return c.json(tx);
});

// GET /categories
app.get("/categories", (c) => {
  const exclude = c.req.query("exclude_ignored") === "true";
  return c.json({ categories: listCategories(exclude) });
});

// GET /summary — monthly summary
app.get("/summary", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const year = c.req.query("year") ? parseInt(c.req.query("year")!) : 2025;
  return c.json({ summary: monthlySummary(memberId, year) });
});

// GET /breakdown — category breakdown
app.get("/breakdown", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  return c.json({
    breakdown: categoryBreakdown(memberId, {
      month: c.req.query("month"),
      year: c.req.query("year") ? parseInt(c.req.query("year")!) : undefined,
    }),
  });
});

export default app;
