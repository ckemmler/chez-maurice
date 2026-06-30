import db from "../db";
import { McpSession } from "./mcpClient";
import { getUser } from "./users";

// Tool families group the ~127 MCP tools by their server prefix (the `prefix__`
// in `calendar__get_events`). A turn exposes only the selected families, so a
// small local model isn't handed the whole arsenal. `web` is a synthetic family
// for the built-in web_search tool.

export interface ToolFamily {
  id: string;
  title: string;
  icon: string;   // SF Symbol hint for the iOS picker
  blurb: string;
  count: number;
  group: "core" | "garden" | "experimental"; // picker section
  alwaysOn: boolean;                          // core families: not user-toggleable
}

// Always available, every turn, regardless of persona/conversation selection —
// not shown as options in the picker.
export const ALWAYS_ON = ["web", "signals"];

// Only Notes + Journal are surfaced as everyday garden tools; everything else
// (the rest of the garden, plus all non-garden families) is Experimental and
// hidden unless a member has been granted access in the admin page.
function groupOf(id: string): "core" | "garden" | "experimental" {
  if (ALWAYS_ON.includes(id)) return "core";
  if (id === "garden-notes" || id === "garden-journal") return "garden";
  return "experimental";
}

/** True for tools whose family is gated behind per-member experimental access. */
export function isExperimentalTool(toolName: string): boolean {
  return groupOf(familyOf(toolName)) === "experimental";
}

// ── Per-member experimental-tools access (admins always have it) ──
export function canUseExperimental(userId: string): boolean {
  if (getUser(userId)?.role === "admin") return true;
  const r = db.query(`SELECT experimental_tools FROM users WHERE id = ?`).get(userId) as { experimental_tools: number } | null;
  return !!r?.experimental_tools;
}

export function setExperimentalAccess(userId: string, on: boolean): void {
  db.run(`UPDATE users SET experimental_tools = ? WHERE id = ?`, [on ? 1 : 0, userId]);
}

/** userId → has experimental access (for the admin matrix). */
export function experimentalAccessMatrix(): Record<string, boolean> {
  const rows = db.query(`SELECT id, role, experimental_tools FROM users`).all() as Array<{ id: string; role: string; experimental_tools: number }>;
  const out: Record<string, boolean> = {};
  for (const r of rows) out[r.id] = r.role === "admin" || !!r.experimental_tools;
  return out;
}

const META: Record<string, { title: string; icon: string; blurb: string }> = {
  web:      { title: "Web search", icon: "globe",                          blurb: "Search the web for current information." },
  tasks:    { title: "Tasks",      icon: "checklist",                      blurb: "To-dos: triage, defer, complete, chain." },
  calendar: { title: "Calendar",   icon: "calendar",                       blurb: "Events and calendar tasks." },
  garden:           { title: "Garden",            icon: "leaf",                          blurb: "Your whole digital garden (54 tools)." },
  "garden-notes":     { title: "Garden · Notes",     icon: "note.text",                    blurb: "Notes — create, edit, publish, images." },
  "garden-journal":   { title: "Garden · Journal",   icon: "moon.stars",                   blurb: "Dreams and daily notes." },
  "garden-people":    { title: "Garden · People",    icon: "person.crop.rectangle.stack",  blurb: "Fiches, contacts, and people." },
  "garden-fragments": { title: "Garden · Fragments", icon: "text.append",                  blurb: "Fragments — capture and summarise." },
  "garden-media":     { title: "Garden · Media",     icon: "play.rectangle.on.rectangle",  blurb: "Books, films, podcasts, series, articles." },
  "garden-publish":   { title: "Garden · Publishing",icon: "paperplane",                   blurb: "Deploy and publish the site." },
  "garden-other":     { title: "Garden · Other",     icon: "leaf",                         blurb: "Other garden tools." },
  health:   { title: "Health",     icon: "heart",                          blurb: "Sleep, HRV, respiratory rate, summaries." },
  tracks:   { title: "Research",   icon: "binoculars",                     blurb: "Deep research, dossiers, briefings, signals." },
  readwise: { title: "Reading",    icon: "book",                           blurb: "Readwise documents and reading activity." },
  contacts: { title: "Contacts",   icon: "person.2",                       blurb: "Look up and search your contacts." },
  social:   { title: "Social",     icon: "bubble.left.and.bubble.right",   blurb: "Twitter, LinkedIn, Reddit." },
  signals:  { title: "Signals",    icon: "waveform.path.ecg",              blurb: "Logging and coaching plans." },
  compte:   { title: "Finances",   icon: "banknote",                       blurb: "Account transactions and budgets." },
  thoughts: { title: "Thoughts",   icon: "brain",                          blurb: "Captured thoughts and summaries." },
  layouts:  { title: "Layouts",    icon: "rectangle.3.group",              blurb: "Saved layouts." },
  calibre:  { title: "Books",      icon: "books.vertical",                 blurb: "Your Calibre library." },
  corpus:   { title: "Corpus",     icon: "doc.text.magnifyingglass",       blurb: "Search your corpus." },
};

/** The raw MCP server prefix of a tool ("garden", "tasks", …) or "web". */
function rawPrefix(toolName: string): string {
  const i = toolName.indexOf("__");
  if (i > 0) return toolName.slice(0, i);
  return toolName === "web_search" ? "web" : "other";
}

// `garden` is 54 tools — too many for one family. Sub-split by what the tool
// touches (order matters: daily-notes are journal, not notes).
function gardenSub(suffix: string): string {
  if (/dream|daily/.test(suffix)) return "garden-journal";
  if (/fragment/.test(suffix)) return "garden-fragments";
  if (/fiche|person|contact/.test(suffix)) return "garden-people";
  if (/resource|book|movie|podcast|series|article/.test(suffix)) return "garden-media";
  if (/deploy|publish|site|content/.test(suffix)) return "garden-publish";
  if (/note|image|evocation|toggle/.test(suffix)) return "garden-notes";
  return "garden-other";
}

/** The family a tool belongs to — its server prefix, with `garden` sub-split. */
export function familyOf(toolName: string): string {
  const prefix = rawPrefix(toolName);
  if (prefix === "garden") return gardenSub(toolName.slice(toolName.indexOf("__") + 2));
  return prefix;
}

/** Is a tool covered by a selected family set? Accepts a sub-family id
 *  (e.g. "garden-notes") and, for back-compat, the parent prefix ("garden"). */
export function toolInFamilies(toolName: string, families: string[]): boolean {
  return families.includes(familyOf(toolName)) || families.includes(rawPrefix(toolName));
}

let cache: { at: number; families: ToolFamily[] } | null = null;
const TTL = 60_000;

/** The household's tool families with live counts (cached briefly). Experimental
 *  families are withheld from members who haven't been granted access. */
export async function listFamilies(memberId: string): Promise<ToolFamily[]> {
  const forMember = (all: ToolFamily[]) =>
    canUseExperimental(memberId) ? all : all.filter((f) => f.group !== "experimental");
  if (cache && Date.now() - cache.at < TTL) return forMember(cache.families);
  const counts: Record<string, number> = { web: 1 };
  try {
    const sess = await McpSession.open(memberId);
    for (const t of await sess.listTools()) {
      const f = familyOf(t.name);
      counts[f] = (counts[f] || 0) + 1;
    }
  } catch {
    // gateway down — fall back to just the web family
  }
  const all = Object.entries(counts)
    .map(([id, count]) => {
      const m = META[id] || { title: id.charAt(0).toUpperCase() + id.slice(1), icon: "wrench.and.screwdriver", blurb: "" };
      return { id, title: m.title, icon: m.icon, blurb: m.blurb, count, group: groupOf(id), alwaysOn: ALWAYS_ON.includes(id) };
    })
    .sort((a, b) => (a.id === "web" ? -1 : b.id === "web" ? 1 : b.count - a.count));
  cache = { at: Date.now(), families: all }; // cache the full set; filter per call
  return forMember(all);
}

function parse(json: string | null | undefined): string[] | null {
  if (json == null) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

/** Resolve the families a turn may use:
 *  conversation override → persona → household default → tier default.
 *  The default is now just the always-on families (web, signals) — everyday
 *  tools are opt-in per chat. Experimental families are dropped for members who
 *  lack access. `memberId` (the member taking the turn) gates that. */
export function resolveFamilies(conversationId: string, isLocal: boolean, memberId?: string): "all" | string[] {
  const tierDefault: string[] = []; // off by default; always-on is unioned below
  const expOK = memberId ? canUseExperimental(memberId) : true;
  const finalize = (f: "all" | string[]): "all" | string[] => {
    if (f === "all") return "all"; // an explicit household/persona "all" (member tools still gated downstream)
    const withCore = [...new Set([...f, ...ALWAYS_ON])];
    return expOK ? withCore : withCore.filter((id) => groupOf(id) !== "experimental");
  };

  const conv = db
    .query(`SELECT tool_families, maurice_id FROM conversations WHERE id = ?`)
    .get(conversationId) as { tool_families: string | null; maurice_id: string | null } | null;
  if (conv?.tool_families != null) return finalize(parse(conv.tool_families) ?? tierDefault);
  if (conv?.maurice_id) {
    const m = db.query(`SELECT tool_families FROM maurices WHERE id = ?`).get(conv.maurice_id) as { tool_families: string | null } | null;
    if (m?.tool_families != null) return finalize(parse(m.tool_families) ?? tierDefault);
  }
  const hh = db.query(`SELECT default_tool_families FROM households WHERE id = 'default'`).get() as { default_tool_families: string | null } | null;
  if (hh?.default_tool_families != null) return finalize(parse(hh.default_tool_families) ?? tierDefault);
  return finalize(tierDefault);
}
