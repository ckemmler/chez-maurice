import { api, loadConfig, originPattern, saveConfig } from "./config.js";

const el = (id) => document.getElementById(id);

init();

async function init() {
  // Listeners first, values after: attaching them behind the await leaves the
  // buttons rendered but inert for as long as storage takes to answer.
  el("save").addEventListener("click", save);
  el("clear").addEventListener("click", clear);

  const config = await loadConfig();
  el("serverUrl").value = config.serverUrl;
  el("token").value = config.token;
  el("locale").value = config.locale || "fr";
}

async function save() {
  const serverUrl = el("serverUrl").value.trim().replace(/\/+$/, "");
  const token = el("token").value.trim();
  const locale = (el("locale").value.trim() || "fr").toLowerCase();

  if (!serverUrl || !token) return setStatus("Both the address and a token are needed.", "bad");

  let pattern;
  try {
    pattern = originPattern(serverUrl);
  } catch {
    return setStatus("That does not look like a URL — include https://", "bad");
  }

  // Host permission is requested for this one origin, at the moment the user
  // asks for it, rather than declared up front for every site. Chrome requires
  // the request to come from a user gesture, which this click is.
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) return setStatus(`Chrome denied access to ${pattern}.`, "bad");

  el("save").disabled = true;
  setStatus("Testing…", "muted");

  // A round-trip that proves address, token and API surface in one call: the
  // lookup route needs a valid member and answers cheaply.
  try {
    await api({ serverUrl, token }, "/api/v1/garden/articles/lookup?url=https://example.com/");
  } catch (err) {
    el("save").disabled = false;
    const message = String(err.message ?? err);
    return setStatus(
      /401|Authentication/i.test(message)
        ? "The server is reachable, but rejected that token."
        : `Could not reach the API: ${message}`,
      "bad",
    );
  }

  await saveConfig({ serverUrl, token, locale });
  el("save").disabled = false;
  setStatus("Connected. Close this tab and clip away.", "good");
}

async function clear() {
  await saveConfig({ token: "" });
  el("token").value = "";
  setStatus("Token forgotten.", "muted");
}

function setStatus(text, className) {
  el("status").textContent = text;
  el("status").className = className ?? "";
}
