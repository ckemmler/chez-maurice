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
//
// `corpus` joined them on 20 September 2026. It is Maurice's memory of what the
// member has already said and kept — the garden, the conversations, the books
// and articles — and a memory you have to remember to switch on is not one:
// until then it was experimental, off by default, and absent from every
// conversation the owner held, so a question that fell squarely into a domain
// could not be followed up even though the index held the answer. It is the
// only always-on family that is private to the member, hence PRIVATE_ONLY
// below.
export const ALWAYS_ON = ["web", "signals", "corpus"];

// Families withheld the moment a conversation has a second participant. The
// corpus is one member's whole indexed life: in a room the turn is taken on
// behalf of whoever spoke, so an unguarded search would read their private
// conversations out to everyone else present. Same rule as the domain briefs
// (services/claude.ts): never in a room, never for another member. The
// member's mailboxes are the same case, through either mail tool, and neither
// can tell on its own: it sees who asked, not who else is listening.
export const PRIVATE_ONLY = ["corpus", "email", "mail"];

/** True for a tool whose family may not be handed to a turn with more than one
 *  participant. */
export function isPrivateOnlyTool(toolName: string): boolean {
  return PRIVATE_ONLY.includes(familyOf(toolName));
}

// ── Which corpus tools a turn may hold ──────────────────────────────────────
//
// The corpus server exposes nineteen tools, and most of them have no business
// in a conversation. Nine of them write: they index a path, prune a source,
// reindex it, import a chat export, map conversations into domains. The server
// calls those itself (mcpClient.corpusCall) on its own schedule; handed to a
// model they are a way to lose the index to a wrong guess. They are never
// offered, whatever the selection says — not even under an explicit "all".
const CORPUS_ADMIN = [
  "corpus__index_path",
  "corpus__index_conversation",
  "corpus__prune",
  "corpus__reindex",
  "corpus__reconcile_status",
  "corpus__map_conversations",
  "corpus__import_chat_export",
  "corpus__import_status",
  "corpus__import_history",
];

// What "remembering" needs and no more: ask the index a question, then widen
// around a passage that answered it. These two ride in every private turn now
// that the family is always on, so they are also two more tool definitions in
// every cached prefix — which is the reason the rest of the reading tools (the
// per-book and per-dossier lookups) wait for a conversation that asks for the
// family outright.
const CORPUS_EVERYDAY = ["corpus__search", "corpus__get_chunk_context"];

/** The corpus tools a turn may hold. `explicit` is true when the turn selected
 *  the family itself rather than receiving it as an always-on one. */
export function corpusToolAllowed(toolName: string, explicit: boolean): boolean {
  if (familyOf(toolName) !== "corpus") return true;
  if (CORPUS_ADMIN.includes(toolName)) return false;
  return explicit || CORPUS_EVERYDAY.includes(toolName);
}

// Only Notes + Journal are surfaced as everyday garden tools; everything else
// (the rest of the garden, plus all non-garden families) is Experimental and
// hidden unless a member has been granted access in the admin page.
function groupOf(id: string): "core" | "garden" | "experimental" {
  if (ALWAYS_ON.includes(id)) return "core";
  // The domain proposal tools are native and granted by the conversation
  // alone (services/domainProposals.ts), never by a family or the flag.
  if (id === "domains") return "core";
  // A member's own mail is granted by their having added a mailbox
  // (hasMailAccount below), not by the admin's experimental tick.
  if (id === "email") return "core";
  if (id === "garden-notes" || id === "garden-journal") return "garden";
  return "experimental";
}

/** True once the member has added a mailbox from the app (mail_accounts).
 *  Accounts in the admin's email.toml are not seen here: those members pick
 *  the Email family by hand, as before. */
export function hasMailAccount(memberId: string): boolean {
  return !!db.query(`SELECT 1 FROM mail_accounts WHERE member_id = ? LIMIT 1`).get(memberId);
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
  "garden-media":     { title: "Garden · Media",     icon: "play.rectangle.on.rectangle",  blurb: "Books, films, games, podcasts, series, articles — and the fiches you take notes in." },
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
  email:    { title: "Email",      icon: "envelope",                       blurb: "Search and read your own mailboxes — never sends, never marks read." },
  domains:  { title: "Domain proposals", icon: "book.closed",              blurb: "Propose, adjust and adopt domains — in the conversation Maurice opened for it." },
};

/** The human names of the families a concrete tool roster covers — what the
 *  model is actually holding this turn, so the system prompt can say it instead
 *  of promising a fixed list the member may never have been granted. */
export function familyTitles(toolNames: string[]): string[] {
  const ids = new Set(toolNames.map(familyOf));
  return [...ids].map((id) => META[id]?.title ?? id).sort();
}

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
  // open_fiche is the media note-taking surface: it pairs with the search_*
  // tools, so it belongs with them rather than with the people fiches — one
  // toggle has to cover the whole pick-then-open flow.
  if (suffix === "open_fiche") return "garden-media";
  if (/fiche|person|contact/.test(suffix)) return "garden-people";
  if (/resource|book|movie|game|podcast|series|article/.test(suffix)) return "garden-media";
  if (/deploy|publish|site|content|flags/.test(suffix)) return "garden-publish";
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
  const expOK = memberId ? canUseExperimental(memberId) : true;
  const chosen = selectedFamilies(conversationId);
  if (chosen === "all") return "all"; // an explicit household/persona "all" (member tools still gated downstream)
  // A member who added a mailbox did it so that Maurice would read it: the
  // family rides in every one of their turns without a picker or an admin.
  // Rooms still withhold it (PRIVATE_ONLY, applied in claude.ts).
  const mail = memberId && hasMailAccount(memberId) ? ["email"] : [];
  const withCore = [...new Set([...chosen, ...ALWAYS_ON, ...mail])];
  return expOK ? withCore : withCore.filter((id) => groupOf(id) !== "experimental");
}

/** The families this turn actually asked for — the conversation's own choice,
 *  else its persona's, else the household's, else none — before the always-on
 *  ones are unioned in. Kept apart from `resolveFamilies` because "the turn
 *  chose this family" and "the turn holds this family" stopped meaning the
 *  same thing when the corpus became always-on: a family nobody picked gets
 *  its everyday tools, not its whole roster. */
export function selectedFamilies(conversationId: string): "all" | string[] {
  const conv = db
    .query(`SELECT tool_families, maurice_id FROM conversations WHERE id = ?`)
    .get(conversationId) as { tool_families: string | null; maurice_id: string | null } | null;
  if (conv?.tool_families != null) return parse(conv.tool_families) ?? [];
  if (conv?.maurice_id) {
    const m = db.query(`SELECT tool_families FROM maurices WHERE id = ?`).get(conv.maurice_id) as { tool_families: string | null } | null;
    if (m?.tool_families != null) return parse(m.tool_families) ?? [];
  }
  const hh = db.query(`SELECT default_tool_families FROM households WHERE id = 'default'`).get() as { default_tool_families: string | null } | null;
  if (hh?.default_tool_families != null) return parse(hh.default_tool_families) ?? [];
  return [];
}
