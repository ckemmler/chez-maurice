import { Hono } from "hono";
import {
  getMindfulMinutesData,
  updateMindfulMinutesData,
} from "../../services/health";
import type { MindfulMinutesDataPayload } from "../../types/health";

const meditation = new Hono();

// GET /api/v1/health/meditation?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
meditation.get("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const startDate = c.req.query("startDate");
    const endDate = c.req.query("endDate");

    if (!startDate || !endDate) {
      return c.json({ error: "Invalid or missing date range" }, 400);
    }

    const data = await getMindfulMinutesData(memberId, startDate, endDate);
    return c.json({ message: "Success", data });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "An error occurred",
      },
      500
    );
  }
});

// POST /api/v1/health/meditation
meditation.post("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const bodyContent = (await c.req.json()) as MindfulMinutesDataPayload;

    if (!bodyContent?.data?.metrics?.[0]?.data) {
      return c.json({ error: "Invalid request format" }, 400);
    }

    const result = await updateMindfulMinutesData(memberId, bodyContent);
    return c.json({ message: "Data updated successfully", result });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "An error occurred",
      },
      500
    );
  }
});

// PUT /api/v1/health/meditation
meditation.put("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const bodyContent = (await c.req.json()) as MindfulMinutesDataPayload;

    if (!bodyContent?.data?.metrics?.[0]?.data) {
      return c.json({ error: "Invalid request format" }, 400);
    }

    const result = await updateMindfulMinutesData(memberId, bodyContent);
    return c.json({ message: "Data updated successfully", result });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "An error occurred",
      },
      500
    );
  }
});

export default meditation;
