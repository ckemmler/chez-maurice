import { Hono } from "hono";
import { getWorkoutsData, updateWorkoutsData } from "../../services/health";
import type { WorkoutsDataPayload } from "../../types/health";

const workouts = new Hono();

// GET /api/v1/health/workouts?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
workouts.get("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const startDate = c.req.query("startDate");
    const endDate = c.req.query("endDate");

    if (!startDate || !endDate) {
      return c.json({ error: "Invalid or missing date range" }, 400);
    }

    const data = await getWorkoutsData(memberId, startDate, endDate);
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

// POST /api/v1/health/workouts
workouts.post("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const bodyContent = (await c.req.json()) as WorkoutsDataPayload;

    if (!bodyContent?.data?.workouts) {
      return c.json({ error: "Invalid request format" }, 400);
    }

    const result = await updateWorkoutsData(memberId, bodyContent);
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

// PUT /api/v1/health/workouts
workouts.put("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const bodyContent = (await c.req.json()) as WorkoutsDataPayload;

    if (!bodyContent?.data?.workouts) {
      return c.json({ error: "Invalid request format" }, 400);
    }

    const result = await updateWorkoutsData(memberId, bodyContent);
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

export default workouts;
