import { Hono } from "hono";
import { createSignal, listSignals, updateSignal, deleteSignal, aggregateSignals } from "../services/signals";
import { parseSignalText } from "../services/signalParser";

const app = new Hono();

app.get("/", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const category = c.req.query("category");
  const since = c.req.query("since");
  const until = c.req.query("until");
  const before = c.req.query("before");
  const limit = c.req.query("limit");

  try {
    const signals = listSignals(memberId, {
      category,
      since,
      until,
      before,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return c.json(signals);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.get("/aggregated", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const category = c.req.query("category");
  if (!category) {
    return c.json({ error: "category is required" }, 400);
  }
  try {
    const result = aggregateSignals(memberId, { category });
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.post("/parse", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const body = await c.req.json<{ text: string; category: string }>();
  if (!body.text || !body.category) {
    return c.json({ error: "text and category are required" }, 400);
  }

  try {
    const parsed = await parseSignalText(body.text, body.category);
    const signal = createSignal(memberId, {
      category: parsed.category,
      details: parsed.details,
      source: "ios",
      tags: parsed.tags,
      metadata: parsed.metadata,
      timestamp: parsed.timestamp,
    });
    return c.json(signal, 201);
  } catch (e: any) {
    console.error("Signal parse error:", e.message);
    return c.json({ error: e.message }, 500);
  }
});

app.post("/", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const body = await c.req.json<{
    category?: string;
    details?: string;
    source?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    timestamp?: string;
  }>();

  if (!body.details) {
    return c.json({ error: "details is required" }, 400);
  }

  try {
    const signal = createSignal(memberId, {
      category: body.category,
      details: body.details,
      source: body.source,
      tags: body.tags,
      metadata: body.metadata,
      timestamp: body.timestamp,
    });
    return c.json(signal, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.put("/:id", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json({ error: "invalid id" }, 400);
  }

  const body = await c.req.json<{
    details?: string;
    category?: string | null;
    tags?: string[];
    timestamp?: string;
    metadata?: Record<string, unknown>;
  }>();

  try {
    const signal = updateSignal(memberId, id, body);
    if (!signal) {
      return c.json({ error: "not found or not editable" }, 404);
    }
    return c.json(signal);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.delete("/:id", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json({ error: "invalid id" }, 400);
  }

  try {
    const deleted = deleteSignal(memberId, id);
    if (!deleted) {
      return c.json({ error: "not found or not deletable" }, 404);
    }
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

export default app;
