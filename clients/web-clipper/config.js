/**
 * Where the server address and token live, and how the popup and the service
 * worker talk to Maurice.
 *
 * Both settings are in `chrome.storage.local`, not `sync`: the token is a
 * credential, and syncing it through a Google account would put it somewhere
 * neither the user nor Maurice controls — the opposite of the point of a
 * self-hosted server.
 */

export async function loadConfig() {
  const { serverUrl = "", token = "", locale = "fr" } =
    await chrome.storage.local.get(["serverUrl", "token", "locale"]);
  return { serverUrl: serverUrl.replace(/\/+$/, ""), token, locale };
}

export async function saveConfig(patch) {
  await chrome.storage.local.set(patch);
}

export function isConfigured({ serverUrl, token }) {
  return Boolean(serverUrl && token);
}

/** The origin pattern to ask `chrome.permissions` for, e.g. "https://host/*". */
export function originPattern(serverUrl) {
  const { protocol, host } = new URL(serverUrl);
  return `${protocol}//${host}/*`;
}

/**
 * A request to the Maurice data API.
 *
 * Called only from the popup or the service worker, never from a content
 * script: those run in the page's own origin and Chrome enforces CORS on them,
 * whereas extension contexts holding `host_permissions` for the server are
 * exempt. The token also has no business being readable by page scripts.
 */
export async function api(config, pathname, { method = "GET", body, signal } = {}) {
  const response = await fetch(`${config.serverUrl}${pathname}`, {
    method,
    signal,
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body means we did not reach the API — a proxy, a login page,
    // or the wrong address. Say that rather than "unexpected token <".
    throw new Error(
      response.ok
        ? "The server answered with something that is not the Maurice API — check the address."
        : `${response.status} ${response.statusText || "error"}`,
    );
  }

  if (!response.ok) {
    throw new Error(payload?.error || `${response.status} ${response.statusText || "error"}`);
  }
  return payload;
}
