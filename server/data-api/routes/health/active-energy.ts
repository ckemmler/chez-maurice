import { Hono } from "hono";
import {
  getHourlyActiveEnergyData,
  updateHourlyActiveEnergyData,
} from "../../services/health";
import type { HourlyActiveEnergyDataPayload } from "../../types/health";

const activeEnergy = new Hono();

// GET /api/v1/health/active-energy?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
activeEnergy.get("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const startDate = c.req.query("startDate");
    const endDate = c.req.query("endDate");

    if (!startDate || !endDate) {
      return c.json({ error: "Invalid or missing date range" }, 400);
    }

    const data = await getHourlyActiveEnergyData(memberId, startDate, endDate);
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

// POST /api/v1/health/active-energy
activeEnergy.post("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const bodyContent = (await c.req.json()) as HourlyActiveEnergyDataPayload;

    if (!bodyContent?.data?.metrics?.[0]?.data) {
      return c.json({ error: "Invalid request format" }, 400);
    }

    const result = await updateHourlyActiveEnergyData(memberId, bodyContent);
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

// PUT /api/v1/health/active-energy
activeEnergy.put("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const bodyContent = (await c.req.json()) as HourlyActiveEnergyDataPayload;

    if (!bodyContent?.data?.metrics?.[0]?.data) {
      return c.json({ error: "Invalid request format" }, 400);
    }

    const result = await updateHourlyActiveEnergyData(memberId, bodyContent);
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

export default activeEnergy;
