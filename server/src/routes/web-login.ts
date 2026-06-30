import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { validateApiTokenRaw } from "../middleware/auth";
import { getUser } from "../services/users";

const webLogin = new Hono();

/**
 * GET /login?token=maur_xxx
 *
 * Validates a member's maur_* API token and sets it as the maurice_session
 * cookie so the browser can access member-scoped web pages (/dossiers, etc.).
 * proxyAuth already handles maur_* tokens read from cookies.
 */
webLogin.get("/", async (c) => {
  const token = c.req.query("token") ?? "";

  if (!token.startsWith("maur_")) {
    return c.html(errorPage("Invalid link. Please generate a new one from the Maurice app."), 400);
  }

  const result = await validateApiTokenRaw(token);
  if (!result) {
    return c.html(errorPage("This link is invalid or has expired. Please generate a new one from the Maurice app."), 401);
  }

  // Store the raw maur_* token as the session cookie.
  // proxyAuth reads this cookie and validates it the same way as a Bearer token.
  setCookie(c, "maurice_session", token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });

  // Land the member in their own garden (carrying the app's chosen web theme),
  // or wherever `to` points — a server-local path only (no open redirect), so
  // the app's ↗ buttons can deep-link a shared garden or a single note.
  const user = getUser(result.userId);
  if (!user) return c.redirect("/dossiers");
  const theme = (c.req.query("theme") ?? "").trim();
  const q = theme ? `?theme=${encodeURIComponent(theme)}` : "";
  const to = c.req.query("to") ?? "";
  if (to.startsWith("/") && !to.startsWith("//") && !to.includes("\\")) {
    return c.redirect(`${to}${to.includes("?") ? "" : q}`);
  }
  return c.redirect(`/g/${user.username}/${q}`);
});

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Maurice — Login</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 20px; background: #f5f5f5; color: #333; }
    .card { background: #fff; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
    p { margin: 0; font-size: 0.95em; color: #c00; }
  </style>
</head>
<body>
  <div class="card">
    <p>${message}</p>
  </div>
</body>
</html>`;
}

export default webLogin;
