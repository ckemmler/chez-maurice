import { Hono } from "hono";
import {
  getHourlyActiveEnergyData,
  getMindfulMinutesData,
  getSleepData,
  getWorkoutsData,
} from "../../services/health";

const health = new Hono();

// GET /api/v1/health?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Returns aggregated health data from all sources
health.get("/", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const startDate = c.req.query("startDate");
    const endDate = c.req.query("endDate");

    if (!startDate || !endDate) {
      return c.json({ error: "Invalid or missing date range" }, 400);
    }

    const [sleepData, mindfulMinutesData, workoutsData, hourlyActiveEnergyData] =
      await Promise.all([
        getSleepData(memberId, startDate, endDate),
        getMindfulMinutesData(memberId, startDate, endDate),
        getWorkoutsData(memberId, startDate, endDate),
        getHourlyActiveEnergyData(memberId, startDate, endDate),
      ]);

    return c.json({
      data: {
        sleep: sleepData,
        mindful_minutes: mindfulMinutesData,
        workouts: workoutsData,
        hourly_active_energy: hourlyActiveEnergyData,
      },
    });
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "An error occurred",
      },
      500
    );
  }
});

export default health;
