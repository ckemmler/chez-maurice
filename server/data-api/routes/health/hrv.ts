import { Hono } from "hono";
import { getHRVData, updateHRVData } from "../../services/health";
import type { HRVDataPayload } from "../../types/health";

const hrv = new Hono();

// GET /api/v1/health/hrv?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
hrv.get("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const startDate = c.req.query("startDate");
    const endDate = c.req.query("endDate");

    if (!startDate || !endDate) {
      return c.json({ error: "Invalid or missing date range" }, 400);
    }

    const data = await getHRVData(memberId, startDate, endDate);
    return c.json({ message: "Success", data });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "An error occurred" },
      500
    );
  }
});

// POST /api/v1/health/hrv
hrv.post("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const bodyContent = (await c.req.json()) as HRVDataPayload;

    if (!bodyContent?.data?.metrics?.[0]?.data) {
      return c.json({ error: "Invalid request format" }, 400);
    }

    const result = await updateHRVData(memberId, bodyContent);
    return c.json({ message: "Data updated successfully", result });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "An error occurred" },
      500
    );
  }
});

// PUT /api/v1/health/hrv
hrv.put("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const bodyContent = (await c.req.json()) as HRVDataPayload;

    if (!bodyContent?.data?.metrics?.[0]?.data) {
      return c.json({ error: "Invalid request format" }, 400);
    }

    const result = await updateHRVData(memberId, bodyContent);
    return c.json({ message: "Data updated successfully", result });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "An error occurred" },
      500
    );
  }
});

export default hrv;
