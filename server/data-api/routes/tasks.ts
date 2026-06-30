import { Hono } from "hono";
import { createSignal } from "../services/signals";
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  completeTask,
  dropTask,
  deferTask,
  getTaskChain,
  getTriageData,
  getStats,
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
} from "../services/tasks";

const tasks = new Hono();

function logTaskSignal(memberId: string, action: string, title: string, meta?: Record<string, unknown>) {
  try {
    createSignal(memberId, {
      details: `${action}: ${title}`,
      source: "tasks",
      tags: ["tasks", action],
      metadata: meta,
    });
  } catch (e) {
    console.error("Failed to log task signal:", e);
  }
}

// ── Task routes ──

// GET / — list tasks
tasks.get("/", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    const result = listTasks(memberId, {
      status: c.req.query("status"),
      category: c.req.query("category"),
      dueBefore: c.req.query("due_before"),
      dueAfter: c.req.query("due_after"),
      overdueOnly: c.req.query("overdue_only") === "true",
      limit: parseInt(c.req.query("limit") || "100", 10),
    });
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST / — create task
tasks.post("/", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    const body = await c.req.json();
    const task = createTask(memberId, {
      title: body.title,
      description: body.description,
      category: body.category,
      status: body.status,
      due: body.due,
      do_date: body.do_date,
      do_date_reason: body.do_date_reason,
      estimated_duration: body.estimated_duration,
      recurrence: body.recurrence,
      tags: body.tags,
      parent_id: body.parent_id,
      link_type: body.link_type,
    });
    return c.json(task, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// PUT /:id — update task
tasks.put("/:id", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const result = updateTask(memberId, id, body);
    if (!result) return c.json({ error: "Not found" }, 404);

    if (body.status !== undefined) {
      logTaskSignal(memberId, body.status, result.title, {
        task_id: id,
        category: result.category,
      });
    }

    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /:id/complete — complete task (with auto-recurrence)
tasks.post("/:id/complete", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const result = completeTask(memberId, id, body);
    if (!result) return c.json({ error: "Not found" }, 404);

    if (result.next_task) {
      const waitingLabel = result.next_task.status === "waiting" ? " (en attente)" : "";
      try {
        createSignal(memberId, {
          details: `done: ${result.completed.title} → ${result.next_task.title}${waitingLabel}`,
          source: "tasks",
          tags: ["tasks", "done", "chain"],
          metadata: {
            task_id: id,
            category: result.completed.category,
            next_action: result.next_task.title,
            next_action_status: result.next_task.status,
            next_task_id: result.next_task.id,
          },
        });
      } catch (e) {
        console.error("Failed to log task signal:", e);
      }
    } else {
      logTaskSignal(memberId, "done", result.completed.title, {
        task_id: id,
        category: result.completed.category,
      });
    }

    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /:id/drop — drop task
tasks.post("/:id/drop", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const result = dropTask(memberId, id, body.reason);
    if (!result) return c.json({ error: "Not found" }, 404);

    logTaskSignal(memberId, "dropped", result.title, {
      task_id: id,
      category: result.category,
      reason: body.reason || null,
    });

    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /:id/defer — defer task
tasks.post("/:id/defer", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const result = deferTask(memberId, id, { due: body.due, note: body.note });
    if (!result) return c.json({ error: "Not found" }, 404);

    logTaskSignal(memberId, "deferred", result.title, {
      task_id: id,
      category: result.category,
      new_due: body.due || null,
    });

    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /:id/chain — full task chain
tasks.get("/:id/chain", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    const id = c.req.param("id");
    const result = getTaskChain(memberId, id);
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /triage — daily planning bundle
tasks.get("/triage", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    return c.json(getTriageData(memberId));
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /stats — completion stats by category
tasks.get("/stats", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    const days = parseInt(c.req.query("days") || "30", 10);
    return c.json(getStats(memberId, days));
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── Category routes ──

// GET /categories
tasks.get("/categories", (c) => {
  try {
    return c.json(listCategories());
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /categories
tasks.post("/categories", async (c) => {
  try {
    const body = await c.req.json();
    if (!body.name) return c.json({ error: "name required" }, 400);
    const result = createCategory(body.name, body.description);
    if ("error" in result) return c.json(result, 409);
    return c.json(result, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// PUT /categories/:name — rename
tasks.put("/categories/:name", async (c) => {
  try {
    const oldName = c.req.param("name");
    const body = await c.req.json();
    if (!body.name) return c.json({ error: "new name required" }, 400);
    const result = renameCategory(oldName, body.name, body.description);
    if ("error" in result) return c.json(result, 404);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// DELETE /categories/:name
tasks.delete("/categories/:name", (c) => {
  try {
    const name = c.req.param("name");
    const reassign = c.req.query("reassign") || null;
    const result = deleteCategory(name, reassign);
    if ("error" in result) return c.json(result, 404);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

export default tasks;
