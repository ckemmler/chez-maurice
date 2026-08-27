import { api, isConfigured, loadConfig } from "./config.js";

/**
 * The server accepts 8 MB of HTML. Stay under it with room to spare for the
 * JSON envelope; past that we send no DOM and the server fetches the URL
 * itself, which is the pre-extension behaviour rather than a failure.
 */
const MAX_HTML = 7_000_000;

const el = (id) => document.getElementById(id);
let config = null;
let captured = null;

init();

async function init() {
  el("open-options").addEventListener("click", openOptions);
  el("settings").addEventListener("click", openOptions);
  el("save").addEventListener("click", save);
  document.addEventListener("keydown", (e) => {
    // Cmd/Ctrl+Enter saves from inside the comment box.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
  });

  config = await loadConfig();
  if (!isConfigured(config)) {
    el("setup").hidden = false;
    return;
  }
  el("main").hidden = false;

  try {
    captured = await capture();
  } catch (err) {
    // chrome:// pages, the Web Store, PDFs — scripting is refused there.
    el("title").textContent = "This page cannot be read";
    el("host").textContent = String(err.message ?? err);
    el("save").disabled = true;
    return;
  }

  el("title").textContent = captured.title || captured.url;
  el("host").textContent = hostOf(captured.url);
  if (captured.selection) el("comment").value = captured.selection;
  el("comment").focus();

  checkAlreadySaved(captured.url);
}

/**
 * Read the rendered DOM out of the active tab.
 *
 * This is the whole reason the extension exists: the page is already loaded,
 * already past the paywall and the bot check that a server-side fetch would
 * meet. `activeTab` grants this only for the tab whose toolbar button was
 * clicked, and only until it navigates — no standing access to every site.
 */
async function capture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      url: location.href,
      title: document.title,
      html: document.documentElement.outerHTML,
      selection: (window.getSelection()?.toString() ?? "").trim().slice(0, 2000),
    }),
  });

  if (!result?.result) throw new Error("Nothing could be read from this tab");
  return result.result;
}

async function checkAlreadySaved(url) {
  try {
    const { saved, article } = await api(
      config,
      `/api/v1/garden/articles/lookup?url=${encodeURIComponent(url)}`,
    );
    if (!saved) return;
    const when = article.saved_at ? ` on ${article.saved_at}` : "";
    el("already").textContent = `Already in your garden${when}. Saving again adds your note to it.`;
    el("already").hidden = false;
    el("save").textContent = "Add note";
  } catch {
    // A lookup failure is not worth interrupting the save for — the server
    // deduplicates again anyway, and that check is the authoritative one.
  }
}

async function save() {
  if (!captured || el("save").disabled) return;
  el("save").disabled = true;
  setStatus("Saving…", "muted");

  const html = captured.html && captured.html.length <= MAX_HTML ? captured.html : undefined;
  if (captured.html && !html) {
    setStatus("Page too large to send — letting the server fetch it…", "muted");
  }

  const payload = {
    url: captured.url,
    html,
    title: captured.title || undefined,
    selection: captured.selection || undefined,
    comment: el("comment").value.trim() || undefined,
    tags: splitTags(el("tags").value),
    locale: config.locale,
    source_client: "chrome",
  };

  // Handed to the service worker so it survives this popup closing.
  const reply = await chrome.runtime.sendMessage({ type: "save-article", payload });

  if (!reply?.ok) {
    setStatus(reply?.error ?? "Save failed", "bad");
    el("save").disabled = false;
    return;
  }

  const { title, publication, duplicate, needs_capture, completed } = reply.result;
  if (needs_capture) {
    // The site refused the server and no DOM got through — the URL and the note
    // are kept, but the article itself is still missing.
    setStatus("Kept as a bookmark — the page could not be read. Reload it and clip again.", "bad");
    el("save").disabled = false;
    return;
  }
  setStatus(
    completed
      ? `Bookmark filled in: ${title}`
      : duplicate
        ? "Already saved — your note was added."
        : `Saved: ${title}${publication ? ` — ${publication}` : ""}`,
    "good",
  );
  setTimeout(() => window.close(), 1200);
}

function splitTags(raw) {
  const tags = raw.split(",").map((t) => t.trim()).filter(Boolean);
  return tags.length ? tags : undefined;
}

function setStatus(text, className) {
  const node = el("status");
  node.textContent = text;
  node.className = className ?? "";
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function openOptions() {
  chrome.runtime.openOptionsPage();
  window.close();
}
