import { Hono } from "hono";
import { getSleepData, updateSleepData } from "../../services/health";
import type { SleepDataPayload } from "../../types/health";

const sleep = new Hono();

// GET /api/v1/health/sleep?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
sleep.get("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const startDate = c.req.query("startDate");
    const endDate = c.req.query("endDate");

    if (!startDate || !endDate) {
      return c.json({ error: "startDate and endDate are required" }, 400);
    }

    const result = await getSleepData(memberId, startDate, endDate);
    return c.json(result);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "An error occurred",
      },
      500
    );
  }
});

// POST /api/v1/health/sleep
sleep.post("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const data = (await c.req.json()) as SleepDataPayload;
    const result = await updateSleepData(memberId, data);
    return c.json(result);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "An error occurred",
      },
      500
    );
  }
});

// PUT /api/v1/health/sleep
sleep.put("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const data = (await c.req.json()) as SleepDataPayload;
    const result = await updateSleepData(memberId, data);
    return c.json(result);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "An error occurred",
      },
      500
    );
  }
});

export default sleep;
