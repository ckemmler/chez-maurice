/**
 * The service worker owns the save.
 *
 * The popup could POST for itself, but a popup is destroyed the moment it loses
 * focus — click Save, glance at another window, and the request is aborted
 * halfway through a git commit on the server. Handing the work to the worker
 * means the save completes whether or not anyone is still watching, and the
 * toolbar badge reports how it went.
 */

import { api, loadConfig } from "./config.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "save-article") return false;

  saveArticle(message.payload)
    .then((result) => {
      flashBadge(result.duplicate ? "•" : "✓", "#4a6b52");
      sendResponse({ ok: true, result });
    })
    .catch((error) => {
      flashBadge("!", "#8a3a3a");
      sendResponse({ ok: false, error: String(error?.message ?? error) });
    });

  return true; // keep the message channel open for the async reply
});

async function saveArticle(payload) {
  const config = await loadConfig();
  return api(config, "/api/v1/garden/articles", { method: "POST", body: payload });
}

function flashBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
}
