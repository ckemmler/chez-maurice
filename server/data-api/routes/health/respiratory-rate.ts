import { Hono } from "hono";
import { getRespiratoryRateData, updateRespiratoryRateData } from "../../services/health";
import type { RespiratoryRateDataPayload } from "../../types/health";

const respiratoryRate = new Hono();

// GET /api/v1/health/respiratory-rate?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
respiratoryRate.get("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const startDate = c.req.query("startDate");
    const endDate = c.req.query("endDate");

    if (!startDate || !endDate) {
      return c.json({ error: "Invalid or missing date range" }, 400);
    }

    const data = await getRespiratoryRateData(memberId, startDate, endDate);
    return c.json({ message: "Success", data });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "An error occurred" },
      500
    );
  }
});

// POST /api/v1/health/respiratory-rate
respiratoryRate.post("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const bodyContent = (await c.req.json()) as RespiratoryRateDataPayload;

    if (!bodyContent?.data?.metrics?.[0]?.data) {
      return c.json({ error: "Invalid request format" }, 400);
    }

    const result = await updateRespiratoryRateData(memberId, bodyContent);
    return c.json({ message: "Data updated successfully", result });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "An error occurred" },
      500
    );
  }
});

// PUT /api/v1/health/respiratory-rate
respiratoryRate.put("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const bodyContent = (await c.req.json()) as RespiratoryRateDataPayload;

    if (!bodyContent?.data?.metrics?.[0]?.data) {
      return c.json({ error: "Invalid request format" }, 400);
    }

    const result = await updateRespiratoryRateData(memberId, bodyContent);
    return c.json({ message: "Data updated successfully", result });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "An error occurred" },
      500
    );
  }
});

export default respiratoryRate;
