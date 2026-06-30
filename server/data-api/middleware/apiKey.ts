import type { MiddlewareHandler } from "hono";

const CALIBRE_API_KEY = process.env.CALIBRE_API_KEY;

export const requireApiKey: MiddlewareHandler = async (c, next) => {
  if (!CALIBRE_API_KEY) {
    return next();
  }

  const provided =
    c.req.header("x-api-key") ?? c.req.query("api_key") ?? undefined;
  if (!provided || provided !== CALIBRE_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
};
