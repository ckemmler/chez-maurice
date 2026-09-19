import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  adminExists,
  createUser,
  listUsers,
  getUser,
  updateUser,
  deleteUser,
  getUserByUsername,
  setUserRole,
  getGuestContacts,
  setGuestContacts, setUserChild } from "../services/users";
import { listMaurices, setAccess } from "../services/maurices";
import { setExperimentalAccess, canUseExperimental } from "../services/toolFamilies";
import {
  createSession,
  validateSession,
  revokeSession,
  verifyPassword,
  createInviteCode,
  getInviteForUser,
  revokeInvite,
  formatInviteCode,
} from "../services/auth";
import db from "../db";
import { DEFAULT_MIN_DAYS, setOpensMinDays } from "../services/openedConversations";
import { getAppDir } from "../../lib/appDir";
import { layout, escape } from "./web-admin-html";
import { createApiToken, listApiTokens, revokeApiToken } from "../middleware/auth";
import { isLoopbackRequest } from "../middleware/loopback";
import {
  setDefaultLibrary,
  getDefaultLibrary,
  removeLibrary,
  validateLibraryRoot,
} from "../services/calibreLibraries";
import { listModels, getModel, addModel, removeModel, setModelCtx, setModelThinking, configuredProviders, THINKING_VALUES, type Model } from "../services/models";
import {
  ancillaryTable, applyRecommendedPins, hasRecommendations, householdAncillaryModel,
  presentInvocations, recommendedModel, setHouseholdAncillaryModel, setPinnedModel,
} from "../services/ancillary";
import {
  accessMatrix,
  accessCounts,
  accessOutside,
  replaceAccess,
  seedDefaultAccess,
  allowedModelIds,
} from "../services/modelAccess";
import { ping, discover, totalRamGB } from "../services/ollama";
import { docsStatus, docsUrl, refreshDocs } from "../services/mauriceDocsRefresh";
import { corpusNightlyStatus, reconcileCorpus } from "../services/corpusNightly";
import { briefsNightlyStatus, runDomainBriefs } from "../services/domainBriefs";
import { ArchiveError, exportResponse } from "../services/archive";
import { t, langOf, SUPPORTED } from "../services/i18n";
import { SYSTEM_SPENDER, spentTodayUsd, spentMonthUsd, memberDailyCap, setMemberDailyCap, setHouseholdDailyCap, setSystemDailyCap } from "../services/budget";
import { corpusCall } from "../services/mcpClient";
import { mkdirSync, readFileSync, existsSync } from "fs";
import { join, resolve, extname } from "path";

const web = new Hono();

// ── Brand assets (public) ───────────────────────────────────────
// Provider logos, the melon-hat logomark and the Young Serif logotype face —
// the same assets the iOS app ships — served for the admin chrome. No auth:
// they're static and also feed the login page's wordmark.
const BRAND_DIR = resolve(import.meta.dir, "../../assets/brand");
const BRAND_MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ttf": "font/ttf",
};
web.get("/brand/:file", (c) => {
  const file = c.req.param("file");
  if (file.includes("/") || file.includes("..")) return c.json({ error: "bad request" }, 400);
  const mime = BRAND_MIME[extname(file).toLowerCase()];
  const path = join(BRAND_DIR, file);
  if (!mime || !existsSync(path)) return c.json({ error: "Not found" }, 404);
  return new Response(readFileSync(path), {
    headers: { "Content-Type": mime, "Cache-Control": "public, max-age=604800" },
  });
});

/** Provider → brand logo file (under /admin/brand/). Ollama has no mark. */
const PROVIDER_LOGO: Record<string, string> = {
  anthropic: "anthropic.svg",
  openai: "openai.svg",
  mistral: "mistral.png",
  zai: "zai.svg",
  gemini: "gemini.svg",
  google: "gemini.svg",
};

/** How a provider is named on screen — the cards of section 03 and the note
 *  under the access grid say it the same way. */
const PROVIDER_TITLE: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  mistral: "Mistral",
  zai: "Z.ai",
  scaleway: "Scaleway",
  ollama: "Ollama",
};

function providerTitle(provider: string): string {
  return PROVIDER_TITLE[provider] ?? provider;
}

/** The header chip for a provider: its real logo, else a glyph fallback. */
function headIcon(provider: string, fallback: string): string {
  const logo = PROVIDER_LOGO[provider];
  return logo
    ? `<span class="head-icon"><img class="head-logo" src="/admin/brand/${logo}" alt="" /></span>`
    : `<span class="head-icon">${fallback}</span>`;
}

function uploadsDir(): string {
  const dir = join(getAppDir(), "uploads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Chat data-export import: one card per provider in the member fiche (below the
// edit form). History/watermark + upload + live progress are driven client-side off
// the /admin/users/:id/import* routes, which proxy the corpus import tools. All UI
// copy is i18n'd: server-rendered titles via t(), client strings via window.IMP_I18N.
const IMPORT_PROVIDERS = [
  { key: "anthropic", label: "Anthropic", source: "Claude.ai → Settings → Privacy" },
  { key: "chatgpt", label: "ChatGPT", source: "ChatGPT → Settings → Data controls" },
];

/** Translated client-side strings, injected as window.IMP_I18N. Runtime values use
 *  {token} placeholders the script substitutes; {provider} is the provider label. */
function importStrings(lang: string): Record<string, string> {
  const k = (key: string) => t(lang, key);
  return {
    choose_first: k("import.choose_first"), not_zip: k("import.not_zip"),
    btn_full: k("import.btn_full"), btn_sync: k("import.btn_sync"), btn_retry: k("import.btn_retry"),
    uploading: k("import.uploading"), empty_hint: k("import.empty_hint"),
    synced_label: k("import.synced_label"), meta_synced: k("import.meta_synced"),
    meta_not_imported: k("import.meta_not_imported"), meta_indexing: k("import.meta_indexing"),
    meta_working: k("import.meta_working"), meta_failed: k("import.meta_failed"),
    meta_unavailable: k("import.meta_unavailable"),
    phase_parsing: k("import.phase_parsing"), phase_indexing: k("import.phase_indexing"),
    phase_working: k("import.phase_working"), keeps_running: k("import.keeps_running"),
    run_meta: k("import.run_meta"), unavailable: k("import.unavailable"),
    failed: k("import.failed"), upload_failed: k("import.upload_failed"),
  };
}

function renderImportSection(user: { id: string; display_name: string }, lang: string): string {
  const mid = escape(user.id);
  const cards = IMPORT_PROVIDERS.map((p) => `
  <div class="card pad imp-card" data-member="${mid}" data-provider="${p.key}" data-provider-label="${escape(p.label)}" style="margin-top:18px">
    <div class="access-head"><span class="ttl2">${escape(t(lang, "import.section_title", p.label))}</span><span class="cnt mono imp-meta">…</span></div>
    <div class="hint" style="margin:6px 0 14px">${escape(t(lang, "import.intro", user.display_name, p.label, p.source))}</div>
    <div class="imp-body"><div class="empty">${escape(t(lang, "import.loading"))}</div></div>
  </div>`).join("");
  return `${cards}
  <script>window.IMP_I18N=${JSON.stringify(importStrings(lang))};${IMPORT_SCRIPT}</script>`;
}

const IMPORT_SCRIPT = `(function(){
  var I = window.IMP_I18N || {};
  function tr(s, v){ s = s || ''; for (var k in (v||{})) s = s.split('{'+k+'}').join(v[k]); return s; }
  function h(s){ return (s==null?'':String(s)); }
  function fmtDate(iso){ if(!iso) return '—'; var d=new Date(iso); if(isNaN(d.getTime())) return iso; return d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}); }
  function isZip(name){ return (name||'').toLowerCase().endsWith('.zip'); }
  document.querySelectorAll('.imp-card').forEach(function(card){
    var member = card.dataset.member, provider = card.dataset.provider, plabel = card.dataset.providerLabel;
    var meta = card.querySelector('.imp-meta'), body = card.querySelector('.imp-body');
    var base = '/admin/users/'+member+'/import', q = '?provider='+encodeURIComponent(provider);
    function uploadRow(label){
      return '<div class="field"><input type="file" class="imp-file" accept=".zip,application/zip" />'
        + '<div class="hint imp-err" style="color:#a6452e;display:none;margin-top:8px"></div>'
        + '<div style="margin-top:12px"><button class="btn primary imp-go">'+label+'</button></div></div>';
    }
    function historyList(runs){
      if(!runs || !runs.length) return '';
      var rows = runs.map(function(r){
        var color = r.status==='partial' ? '#b97a1e' : r.status==='failed' ? '#a6452e' : '#3d6b4f';
        return '<div style="display:flex;gap:10px;padding:8px 0;border-top:0.5px solid var(--rule)">'
          + '<span style="width:8px;height:8px;border-radius:4px;margin-top:5px;flex:0 0 auto;background:'+color+'"></span>'
          + '<div style="flex:1"><div class="mono" style="font-size:12px">'+fmtDate(r.range_from)+' → '+fmtDate(r.range_to)+'</div>'
          + '<div class="mono" style="font-size:10px;color:var(--ink-mute)">'+tr(I.run_meta,{conversations:h(r.conversations),messages:h(r.messages)})+' · '+fmtDate(r.ran_at)+' · '+h(r.status)+'</div></div></div>';
      }).join('');
      return '<div style="margin:6px 0 14px">'+rows+'</div>';
    }
    function watermarkCard(wm){
      return '<div style="display:flex;align-items:center;gap:10px;padding:11px 13px;border-radius:11px;background:rgba(61,107,79,0.10);box-shadow:inset 0 0 0 0.5px rgba(61,107,79,0.25);margin-bottom:14px">'
        + '<span class="mono" style="font-size:10px;letter-spacing:0.1em">'+h(I.synced_label)+'</span><span style="font-weight:600">'+fmtDate(wm)+'</span></div>';
    }
    function renderIdle(data){
      var runs = (data && data.history) || [], wm = data && data.watermark;
      if(wm){ meta.textContent = I.meta_synced+' '+fmtDate(wm); body.innerHTML = watermarkCard(wm)+historyList(runs)+uploadRow(I.btn_sync); }
      else { meta.textContent = I.meta_not_imported; body.innerHTML = '<div class="hint" style="margin-bottom:10px">'+h(I.empty_hint)+'</div>'+uploadRow(I.btn_full); }
      wireUpload();
    }
    function renderRunning(job){
      var done = job.done||0, total = job.total||0, pct = total ? Math.round(done/total*100) : 0;
      var phase = job.phase==='parsing' ? I.phase_parsing : job.phase==='indexing' ? tr(I.phase_indexing,{done:done,total:total}) : I.phase_working;
      meta.textContent = total ? (I.meta_indexing+' '+done+'/'+total) : I.meta_working;
      body.innerHTML = '<div class="hint" style="margin-bottom:10px">'+h(phase)+'</div>'
        + '<div style="height:8px;border-radius:6px;background:var(--inset,#efe7d8);overflow:hidden"><div style="height:100%;width:'+pct+'%;background:#3d6b4f;transition:width .3s"></div></div>'
        + '<div class="hint" style="margin-top:10px;font-size:11px">'+h(I.keeps_running)+'</div>';
    }
    function renderError(msg){
      meta.textContent = I.meta_failed;
      body.innerHTML = '<div class="hint" style="color:#a6452e;margin-bottom:10px">'+h(msg||I.failed)+'</div>'+uploadRow(I.btn_retry);
      wireUpload();
    }
    function wireUpload(){
      var go = body.querySelector('.imp-go'); if(!go) return;
      go.addEventListener('click', function(){
        var f = body.querySelector('.imp-file'), err = body.querySelector('.imp-err');
        if(!f.files || !f.files[0]){ err.style.display='block'; err.textContent=tr(I.choose_first,{provider:plabel}); return; }
        var file = f.files[0];
        if(!isZip(file.name)){ err.style.display='block'; err.textContent=tr(I.not_zip,{provider:plabel}); return; }
        var fd = new FormData(); fd.append('file', file);
        go.disabled = true; go.textContent = I.uploading;
        fetch(base+q, { method:'POST', body: fd }).then(function(r){ return r.json(); }).then(function(res){
          if(res.error || !res.job_id){ renderError(res.error || I.upload_failed); return; }
          poll(res.job_id);
        }).catch(function(e){ renderError(String(e)); });
      });
    }
    function poll(jobId){
      function tick(){
        fetch(base+'/status?job='+encodeURIComponent(jobId)).then(function(r){ return r.json(); }).then(function(st){
          if(st.phase==='done'){ load(); return; }
          if(st.phase==='error' || st.status==='failed'){ renderError(st.error || I.failed); return; }
          renderRunning(st); setTimeout(tick, 1000);
        }).catch(function(e){ renderError(String(e)); });
      }
      tick();
    }
    function load(){
      fetch(base+'/history'+q).then(function(r){ return r.json(); }).then(function(d){
        if(d && d.error){ body.innerHTML='<div class="hint">'+h(I.unavailable)+'</div>'; meta.textContent=I.meta_unavailable; return; }
        renderIdle(d);
      }).catch(function(){ body.innerHTML='<div class="hint">'+h(I.unavailable)+'</div>'; meta.textContent=I.meta_unavailable; });
    }
    load();
  });
})();`;

const COLORS = [
  "#a6452e", "#b97a1e", "#b5a13a", "#3d6b4f", "#2c5aa0",
  "#5b4b8a", "#9c5a7a", "#4f7a78", "#2a2622",
];

// ── Localhost-only guard ────────────────────────────────────────
// The admin dashboard exposes every provider API key, so it must be reachable
// only from the machine itself, never through the public Cloudflare tunnel.
// Two independent signals, because neither alone is sufficient:
//  - Host header: the client sets it, so `Host: localhost` can be forged. But a
//    request that arrived over the tunnel carries Cloudflare's edge headers
//    (cf-ray / cf-connecting-ip), which the origin adds and a client cannot fake
//    into a genuine loopback connection. The tunnel also terminates at
//    localhost:3001, so the socket peer is 127.0.0.1 for ALL tunneled traffic —
//    the socket address can't tell local from remote here; the CF header can.
// So: require a local Host AND the absence of any Cloudflare edge header. Real
// local admin use (Candide on the mac-mini) has neither problem; a tunneled
// request is refused whatever Host it claims.
// (The test itself now lives in middleware/loopback.ts, shared with the
// ancillary turn endpoint, which needs exactly the same promise.)
web.use("/*", async (c, next) => {
  if (!isLoopbackRequest(c)) {
    return c.text("Admin is only accessible from localhost", 403);
  }
  // Persist a chosen language (?lang=xx) so it sticks across requests.
  const ql = c.req.query("lang");
  if (ql && (SUPPORTED as readonly string[]).includes(ql)) {
    setCookie(c, "maurice_admin_lang", ql, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  }
  await next();
});

// ── Session helpers ─────────────────────────────────────────────
function getAdminSession(c: any): { userId: string } | null {
  const token = getCookie(c, "maurice_admin");
  if (!token) return null;
  const session = validateSession(token);
  if (!session) return null;
  const user = getUser(session.userId);
  if (!user || user.role !== "admin") return null;
  return { userId: session.userId };
}

function requireWebAdmin(c: any): Response | null {
  if (!getAdminSession(c)) return c.redirect("/admin/login");
  return null;
}

function adminName(c: any): string {
  const s = getAdminSession(c);
  return s ? getUser(s.userId)?.display_name || "" : "";
}

// ── small render helpers ────────────────────────────────────────
// ── Ancillary models ─────────────────────────────────────────────
// The models behind everything that is not the chat: summaries, flashcards,
// signal parsing, the tools' classifiers and syntheses. One household default
// that every function runs on unless pinned, and a pin per function. Only
// models whose provider has a key are offered — a pin the household cannot
// call would silently fall back anyway (services/ancillary.ts).
function ancillaryCard(lang: string): string {
  const ok = configuredProviders();
  const models = listModels().filter((m) => ok.has(m.provider));
  const options = (selected: string | null, blank?: string) =>
    (blank !== undefined ? `<option value="" ${!selected ? "selected" : ""}>${escape(blank)}</option>` : "") +
    models.map((m) =>
      `<option value="${escape(m.id)}" ${m.id === selected ? "selected" : ""}>${escape(m.name)}${m.tier === "local" ? " · " + escape(t(lang, "settings.on_device")) : ""}</option>`).join("");
  const advisable = hasRecommendations();
  // Two lines per function rather than one: the tier says what the job asks of
  // a model, and when nothing is pinned the row still has to say what it will
  // actually run on, which is the household model and usually too big for it.
  const rows = ancillaryTable().map((r) => {
    const effective = getModel(r.effective)?.name ?? r.effective;
    const advised = recommendedModel(r.id);
    const state = r.pinned
      ? (advised && r.pinned !== advised
          ? `<span class="hint">${escape(t(lang, "ancillary.advised_is", getModel(advised)?.name ?? advised))}</span>`
          : "")
      : `<span class="hint">${escape(t(lang, "ancillary.runs_on", effective))}</span>`;
    // The tools that ask the server for their turn take any provider. The
    // research pipelines still choose one themselves, so nothing is advised
    // for them and the row says why rather than leaving a silent gap.
    const toolsWarning = r.ownDispatch
      ? `<span class="hint" style="color:var(--caution)">${escape(t(lang, "ancillary.tools_anthropic_only"))}</span>`
      : "";
    return `
      <div class="field" style="margin-top:12px">
        <label class="label">${escape(r.label)} <span class="hint">· ${escape(t(lang, r.side === "server" ? "ancillary.side_server" : "ancillary.side_tools"))} · ${escape(t(lang, `ancillary.tier_${r.tier}`))}</span></label>
        <select name="pin:${escape(r.id)}">${options(r.pinned, t(lang, "ancillary.household_default_option"))}</select>
        <span class="hint">${escape(r.blurb)}</span>
        ${state}${toolsWarning}
      </div>`;
  }).join("");
  // The button is only honest when there is something to advise.
  const rangeRow = advisable
    ? `<div class="grid-actions" style="justify-content:flex-start">
         <button type="submit" form="ancillary-range-form" class="btn ghost sm">${escape(t(lang, "ancillary.apply_range"))}</button>
       </div>`
    : `<div class="hint">${escape(t(lang, "ancillary.no_range"))}</div>`;
  return `
        <details class="card pad" style="margin-top:18px">
          <summary style="cursor:pointer"><span class="ttl2">${escape(t(lang, "ancillary.title"))}</span>
            <span class="hint" style="display:inline;margin-left:8px">${escape(t(lang, "ancillary.advanced"))}</span></summary>
          <div class="hint" style="margin:10px 0 12px">${escape(t(lang, "ancillary.desc"))}</div>
          ${rangeRow}
          <form method="POST" action="/admin/ancillary-models">
            <div class="field" style="margin-top:12px"><label class="label">${escape(t(lang, "ancillary.household_default"))}</label>
              <select name="ancillary_model">${options(householdAncillaryModel())}</select>
              <span class="hint">${escape(t(lang, "ancillary.household_default_hint"))}</span></div>
            ${rows}
            <div class="grid-actions"><button type="submit" class="btn primary">${escape(t(lang, "settings.save"))}</button></div>
          </form>
        </details>
        <form method="POST" action="/admin/ancillary-models/range" id="ancillary-range-form"></form>`;
}

function sectionHead(kicker: string, title: string, desc: string, action = ""): string {
  return `
  <div class="sec-headrow">
    <div>
      <div class="kicker">${escape(kicker)}</div>
      <div class="sec-title">${escape(title)}</div>
      ${desc ? `<div class="sec-desc">${escape(desc)}</div>` : ""}
    </div>
    ${action}
  </div>`;
}

function avatarHtml(u: { avatar_url: string | null; avatar_color: string; display_name: string }, size = 38): string {
  const s = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`;
  if (u.avatar_url) {
    return `<span class="avatar" style="${s};background-image:url('${escape(u.avatar_url)}')"></span>`;
  }
  return `<span class="avatar" style="${s};background:${escape(u.avatar_color)}">${escape(u.display_name[0] || "?")}</span>`;
}

function shortName(m: Model): string {
  if (m.tier === "cloud") return m.name.replace(/^Claude\s+/, "");
  return m.name.split(" ").slice(0, 2).join(" ");
}

// ── Calibre (JSON, unchanged) ───────────────────────────────────
web.get("/calibre", (c) => {
  if (!getAdminSession(c)) return c.json({ error: "admin required" }, 401);
  const out = listUsers().map((u) => {
    const lib = getDefaultLibrary(u.id);
    return {
      account_id: u.id, username: u.username, display_name: u.display_name,
      library: lib ? { id: lib.id, label: lib.label, library_root: lib.library_root } : null,
    };
  });
  return c.json(out);
});
web.post("/calibre", async (c) => {
  if (!getAdminSession(c)) return c.json({ error: "admin required" }, 401);
  const { account_id, library_root, label } = await c.req.json().catch(() => ({}));
  if (!account_id || !getUser(account_id)) return c.json({ error: "unknown account" }, 404);
  if (!library_root) return c.json({ error: "library_root required" }, 400);
  try {
    const lib = setDefaultLibrary(account_id, library_root, label || "Library");
    return c.json({ ok: true, library: lib }, 201);
  } catch (e: any) {
    return c.json({ error: e?.message ?? "invalid library" }, 422);
  }
});
web.delete("/calibre/:id", (c) => {
  if (!getAdminSession(c)) return c.json({ error: "admin required" }, 401);
  const { account_id } = c.req.query();
  if (!account_id) return c.json({ error: "account_id required" }, 400);
  return c.json({ ok: removeLibrary(account_id, c.req.param("id")) });
});

// ── Global Calibre library (HTML admin form) ────────────────────
// One shared library for the household. The data-api + Python MCP tools read
// this same row (admin account's default) to locate books/chapters/summaries.
web.get("/library", (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const session = getAdminSession(c)!;
  const lang = langOf(c);
  const error = c.req.query("error");
  const saved = c.req.query("msg") === "library_saved";

  const lib = getDefaultLibrary(session.userId);
  const root = lib?.library_root ?? "";
  const check = root ? validateLibraryRoot(root) : null;

  const status = check
    ? check.ok
      ? `<p class="ok">✓ ${check.bookCount} books at this library.</p>`
      : `<p class="error">${escape(check.error || "Library not readable.")}</p>`
    : `<p class="sec-desc" style="margin:0">No library configured yet.</p>`;

  return c.html(layout("Calibre library", `
    <form method="POST" action="/admin/library">
      <div class="card dialog">
        <div class="dialog-head"><div><div class="eyebrow">Reading</div><div class="ttl">Calibre library</div></div></div>
        <div class="dialog-body">
          <p class="sec-desc" style="margin:0 0 10px">The folder that contains <span class="mono">metadata.db</span> — the shared Calibre library the reading features serve.</p>
          ${saved ? `<p class="ok">Library saved.</p>` : ""}
          ${error ? `<p class="error">${escape(error)}</p>` : ""}
          <div class="field">
            <label class="label">Library root</label>
            <input type="text" name="library_root" class="mono" placeholder="/Users/candide/media/Livres" value="${escape(root)}" required />
          </div>
          ${status}
        </div>
        <div class="dialog-foot">
          <a href="/admin/dashboard" class="btn ghost">${escape(t(lang, "common.cancel"))}</a>
          <button type="submit" class="btn accent">Save library</button>
        </div>
      </div>
    </form>`, true, adminName(c), lang));
});

web.post("/library", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const session = getAdminSession(c)!;
  const form = await c.req.parseBody();
  const root = ((form.library_root as string) || "").trim();
  if (!root) return c.redirect("/admin/library?error=" + encodeURIComponent("Library root is required."));
  try {
    setDefaultLibrary(session.userId, root, "Library");
    return c.redirect("/admin/library?msg=library_saved");
  } catch (e: any) {
    return c.redirect("/admin/library?error=" + encodeURIComponent(e?.message ?? "Invalid library."));
  }
});

// ── GET /admin ──────────────────────────────────────────────────
web.get("/", (c) => {
  if (!adminExists()) return c.redirect("/admin/setup");
  if (!getAdminSession(c)) return c.redirect("/admin/login");
  return c.redirect("/admin/dashboard");
});

// ── Setup ───────────────────────────────────────────────────────
web.get("/setup", (c) => {
  if (adminExists()) return c.redirect("/admin/login");
  const lang = langOf(c);
  return c.html(layout(t(lang, "setup.title"), `
    <div class="card pad setup">
      <div class="kicker">${escape(t(lang, "setup.eyebrow"))}</div>
      <div class="sec-title">Chez Maurice</div>
      <p class="sec-desc">${escape(t(lang, "setup.desc"))}</p>
      <form method="POST" action="/admin/setup" style="margin-top:18px">
        <div class="field"><label class="label" for="username">${escape(t(lang, "setup.username"))}</label>
          <input type="text" id="username" name="username" required autofocus autocomplete="username" /></div>
        <div class="field"><label class="label" for="display_name">${escape(t(lang, "common.display_name"))}</label>
          <input type="text" id="display_name" name="display_name" required /></div>
        <div class="field"><label class="label" for="password">${escape(t(lang, "setup.password"))}</label>
          <input type="password" id="password" name="password" required minlength="4" autocomplete="new-password" /></div>
        <div class="grid-actions"><button type="submit" class="btn primary">${escape(t(lang, "setup.submit"))}</button></div>
      </form>
    </div>`, false, "", lang));
});
web.post("/setup", async (c) => {
  if (adminExists()) return c.redirect("/admin/login");
  const form = await c.req.parseBody();
  const username = (form.username as string)?.trim();
  const display_name = (form.display_name as string)?.trim();
  const password = form.password as string;
  if (!username || !password || !display_name) return c.redirect("/admin/setup");
  const user = await createUser({ username, display_name, role: "admin", password, avatar_color: "#2a2622" });
  const { token } = createSession(user.id);
  setCookie(c, "maurice_admin", token, { path: "/admin", httpOnly: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 30 });
  setCookie(c, "maurice_session", token, { path: "/", httpOnly: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 30 });
  return c.redirect("/admin/dashboard");
});

// ── Login ───────────────────────────────────────────────────────
web.get("/login", (c) => {
  if (!adminExists()) return c.redirect("/admin/setup");
  if (getAdminSession(c)) return c.redirect("/admin/dashboard");
  const lang = langOf(c);
  const error = c.req.query("error");
  return c.html(layout(t(lang, "login.title"), `
    <div class="card pad setup">
      <div class="kicker">${escape(t(lang, "login.eyebrow"))}</div>
      <div class="sec-title">Chez Maurice</div>
      ${error ? `<p class="error" style="margin-top:14px">${escape(t(lang, "login." + error))}</p>` : ""}
      <form method="POST" action="/admin/login" style="margin-top:18px">
        <div class="field"><label class="label" for="username">${escape(t(lang, "setup.username"))}</label>
          <input type="text" id="username" name="username" required autofocus autocomplete="username" /></div>
        <div class="field"><label class="label" for="password">${escape(t(lang, "setup.password"))}</label>
          <input type="password" id="password" name="password" required autocomplete="current-password" /></div>
        <div class="grid-actions"><button type="submit" class="btn primary">${escape(t(lang, "login.submit"))}</button></div>
      </form>
    </div>`, false, "", lang));
});
web.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const username = (form.username as string)?.trim();
  const password = form.password as string;
  if (!username || !password) return c.redirect("/admin/login?error=err_credentials_required");
  const record = getUserByUsername(username);
  if (!record || record.role !== "admin" || !record.password_hash) return c.redirect("/admin/login?error=err_invalid");
  if (!(await verifyPassword(password, record.password_hash))) return c.redirect("/admin/login?error=err_invalid");
  const { token } = createSession(record.id);
  setCookie(c, "maurice_admin", token, { path: "/admin", httpOnly: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 30 });
  setCookie(c, "maurice_session", token, { path: "/", httpOnly: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 30 });
  return c.redirect("/admin/dashboard");
});
web.get("/logout", (c) => {
  const token = getCookie(c, "maurice_admin");
  if (token) {
    revokeSession(token);
    deleteCookie(c, "maurice_admin", { path: "/admin" });
    deleteCookie(c, "maurice_session", { path: "/" });
  }
  return c.redirect("/admin/login");
});

// ── Dashboard ───────────────────────────────────────────────────
web.get("/dashboard", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const lang = langOf(c);

  const users = listUsers();
  const household = db.query(`SELECT * FROM households WHERE id = 'default'`).get() as any;
  const models = listModels();
  const cloud = models.filter((m) => m.tier === "cloud");
  const local = models.filter((m) => m.tier === "local");
  // A model whose provider has no key cannot be called by anyone: the apps
  // never list it (`availableModels`), and a turn on it would fail. It is
  // therefore not an access decision — it is a key decision, taken in the
  // provider cards of section 03 — so the grid below leaves it out rather than
  // offering a tick box that promises a member something they never get.
  const keyed = configuredProviders();
  const callable = (m: Model) => keyed.has(m.provider);
  const unkeyed = models.filter((m) => !callable(m));
  const counts = accessCounts();
  const access = accessMatrix();
  const memberCount = users.length;
  const flash = c.req.query("msg");

  const olla = await ping();
  const scanned = household.ollama_scanned_at as string | null;
  const total = totalRamGB();
  const maxRam = local.length ? Math.max(...local.map((m) => m.ram || 0)) : 0;

  // ── 01 members ──
  // Today's spend beside the handle, only once the ledger has something for
  // them: a household on its own key, or on Ollama, never sees a figure.
  const spentTag = (id: string) => {
    const today = spentTodayUsd(id);
    return today > 0 ? ` · <span title="${escape(t(lang, "members.spent_today_title"))}">${escape(t(lang, "members.spent_today", today.toFixed(2)))}</span>` : "";
  };
  const memberRows = users.map((u) => `
    <div class="member">
      ${avatarHtml(u)}
      <div class="who"><div class="nm">${escape(u.display_name)}</div><div class="hd">@${escape(u.username)}${spentTag(u.id)}</div></div>
      <span class="tag ${u.role}">${escape(t(lang, "members.role_" + u.role))}</span>${u.is_child ? ` <span class="tag" title="${escape(t(lang, "members.is_child_hint"))}">${escape(t(lang, "members.child_tag"))}</span>` : ""}
      <span class="pin">${u.has_pin ? "🔒 " + escape(t(lang, "members.pin_set")) : escape(t(lang, "members.no_pin"))}</span>
      <div class="member-actions">
        <a href="/admin/users/${u.id}/edit" class="btn ghost sm">${escape(t(lang, "common.edit"))}</a>
        ${u.role !== "admin" ? `<form method="POST" action="/admin/users/${u.id}/delete" class="inline" onsubmit="return confirm('${escape(t(lang, "members.confirm_remove", u.display_name))}')"><button type="submit" class="btn danger sm">${escape(t(lang, "common.remove"))}</button></form>` : ""}
      </div>
    </div>`).join("");

  // ── 03 model rows ──
  const modelRow = (m: Model, removable: boolean) => `
    <div class="model-row">
      <span class="model-icon ${m.tier === "local" ? "local" : "cloud"}">${m.tier === "local" ? "▦" : "☁"}</span>
      <div class="model-main">
        <div><span class="model-name">${escape(m.name)}</span><span class="model-id">${escape(m.id)}</span></div>
        <div class="model-desc">${escape(m.descr)}</div>
      </div>
      <div class="model-meta">
        <form method="POST" action="/admin/models/${encodeURIComponent(m.id)}/ctx" class="inline" title="${escape(t(lang, "models.ctx_title"))}">
          <input type="number" name="ctx" value="${m.ctx}" min="1" max="10000" class="mono ctx-in" onchange="this.form.submit()" />k
        </form>
        <form method="POST" action="/admin/models/${encodeURIComponent(m.id)}/thinking" class="inline" title="${escape(t(lang, "models.thinking_title"))}">
          <select name="thinking" class="mono" onchange="this.form.submit()">
            ${THINKING_VALUES.map((v) => `<option value="${v}"${m.thinking === v ? " selected" : ""}>${escape(t(lang, `models.thinking.${v}`))}</option>`).join("")}
          </select>
        </form>
        ${m.tier === "local" ? `<span class="mono-num" style="width:60px">${m.ram ?? "?"} GB</span>` : ""}
        ${callable(m)
          ? `<span class="mono-num" style="width:92px;color:${counts[m.id] ? "var(--ink)" : "var(--ink-mute)"}">${escape(t(lang, "models.can_use", counts[m.id] || 0, memberCount))}</span>`
          // No key, so nobody can use it whatever the access table says.
          : `<span class="mono-num" style="width:92px;color:var(--ink-mute)">${escape(t(lang, "settings.no_key"))}</span>`}
        ${removable ? `<form method="POST" action="/admin/models/${encodeURIComponent(m.id)}/delete" class="inline" onsubmit="return confirm('${escape(t(lang, "models.confirm_remove", m.name))}')"><button class="trash" title="${escape(t(lang, "models.remove_title"))}">🗑</button></form>` : `<span style="width:21px"></span>`}
      </div>
    </div>`;

  const ollamaBody = olla.connected
    ? `${local.map((m) => modelRow(m, !m.discovered)).join("") || `<div class="empty">${t(lang, "models.no_local")}</div>`}
       <div class="addbar"><a href="/admin/models/new" class="btn ghost sm">+ ${escape(t(lang, "models.add_manual"))}</a></div>`
    : `<div class="empty">${t(lang, "models.ollama_start", escape(olla.host))}<div style="margin-top:12px"><form method="POST" action="/admin/models/rescan" class="inline"><button class="btn default sm">↻ ${escape(t(lang, "models.try_again"))}</button></form></div></div>`;

  const ramGauge = olla.connected
    ? `<span class="ram-bar"><span class="ram-lab">${escape(t(lang, "models.largest_fits"))}</span><span class="ram-track"><span class="ram-fill" style="width:${Math.min(100, total ? (maxRam / total) * 100 : 0)}%"></span></span><span class="ram-num">${maxRam} / ${total} GB</span></span>`
    : "";

  // ── 04 matrix ──
  const colW = 88, nameW = 208;
  const groups = [
    { tier: "cloud", label: t(lang, "access.group_cloud"), items: cloud.filter(callable) },
    { tier: "local", label: t(lang, "access.group_local"), items: local.filter(callable) },
  ];
  const minW = nameW + groups.reduce((a, g) => a + g.items.length * colW, 0);
  // Say what is missing and why, rather than let a provider's models vanish
  // without a word. Names the providers, because that is where the fix is.
  const unkeyedNote = unkeyed.length
    ? `<div class="hint" style="padding:14px 18px 0">${escape(t(lang, "access.hidden_no_key", unkeyed.length,
        [...new Set(unkeyed.map((m) => providerTitle(m.provider)))].join(", ")))}</div>`
    : "";
  const matrix = groups.every((g) => !g.items.length)
    ? `${unkeyedNote}<div class="empty">${escape(t(lang, "access.nothing_callable"))}</div>`
    : `${unkeyedNote}`.concat(`
    <div class="matrix-scroll"><div style="min-width:${minW}px">
      <div class="mx-grouphead">
        <div class="mx-namecol"></div>
        ${groups.map((g) => `<div class="mx-col" style="width:${g.items.length * colW}px;border-left:0.5px solid var(--rule)"><div class="mx-group-lab ${g.tier}">${g.label}</div></div>`).join("")}
      </div>
      <div class="mx-modelhead">
        <div class="mx-namecol mx-head-member">${escape(t(lang, "access.member"))}</div>
        ${groups.map((g) => g.items.map((m) => `
          <div class="mx-col mx-modelcell">
            ${m.id === household.default_model ? `<div class="star" title="${escape(t(lang, "access.household_default"))}">★</div>` : ""}
            <div class="mx-short">${escape(shortName(m))}</div>
            <div class="mx-sub">${m.tier === "local" ? `${m.ram ?? "?"}GB` : `${m.ctx}k`}</div>
          </div>`).join("")).join("")}
      </div>
      ${users.map((u) => {
        const admin = u.role === "admin";
        const allowed = new Set(access[u.id] || []);
        return `<div class="mx-row">
          <div class="mx-namecol mx-member">${avatarHtml(u, 30)}
            <div style="min-width:0;flex:1"><div class="mx-mem-nm">${escape(u.display_name)}</div>
            <div class="mx-mem-sub ${admin ? "admin" : ""}">${admin ? escape(t(lang, "access.admin_all")) : escape(t(lang, "access.n_models", (access[u.id] || []).length))}</div></div>
          </div>
          ${groups.map((g) => g.items.map((m) => {
            const on = admin || allowed.has(m.id);
            if (admin) return `<div class="mx-col mx-cell"><span class="cellbox locked"><span class="dot" style="background:${m.tier === "local" ? "var(--ok)" : "var(--cloud)"}">🔒</span></span></div>`;
            return `<div class="mx-col mx-cell"><label class="cellbox ${m.tier}">
              <input type="checkbox" name="access" value="${escape(u.id)}|${escape(m.id)}" ${on ? "checked" : ""} />
              <span class="dot"><span class="pip"></span><span class="chk">✓</span></span></label></div>`;
          }).join("")).join("")}
        </div>`;
      }).join("")}
    </div></div>`);

  const modelOptions = models.map((m) =>
    `<option value="${escape(m.id)}" ${m.id === household.default_model ? "selected" : ""}>${escape(m.name)}${m.tier === "local" ? " · " + escape(t(lang, "settings.on_device")) : ""}</option>`).join("");

  // One card per cloud provider (skipped if it has neither models nor a key).
  const CLOUD_PROVIDERS: Array<[string, string, boolean, string]> = [
    ["Anthropic", "anthropic", !!household.api_key, "api.anthropic.com"],
    ["OpenAI", "openai", !!household.openai_api_key, "api.openai.com"],
    ["Mistral", "mistral", !!household.mistral_api_key, "api.mistral.ai"],
    ["Z.ai", "zai", !!household.zai_api_key, "api.z.ai"],
    ["Scaleway", "scaleway", !!household.scaleway_api_key, "api.scaleway.ai"],
  ];
  const cloudCards = CLOUD_PROVIDERS.map(([title, provider, keySet, host]) => {
    const list = cloud.filter((m) => m.provider === provider);
    if (list.length === 0 && !keySet) return "";
    const dot = keySet ? "var(--cloud)" : "var(--ink-mute)";
    return `
      <div class="card flush">
        <div class="model-head cloud">
          ${headIcon(provider, "☁")}
          <div class="head-main"><div class="head-title">${title}</div>
            <div class="head-meta">${host} · ${keySet ? escape(t(lang, "settings.key_set")) : escape(t(lang, "settings.no_key"))} · ${escape(t(lang, "settings.metered"))}</div></div>
          <span class="status-dot" style="color:${dot}"><span class="dotmark" style="background:${dot}"></span>${keySet ? escape(t(lang, "settings.connected")) : escape(t(lang, "settings.no_key"))}</span>
        </div>
        ${list.map((m) => modelRow(m, true)).join("") || `<div class="empty">${escape(t(lang, "models.no_models_add"))}</div>`}
        <div class="addbar"><a href="/admin/models/new?provider=${provider}" class="btn ghost sm">+ ${escape(t(lang, "models.add_provider", title))}</a></div>
      </div>`;
  }).join("");

  // ── 05 other API keys ──
  // Same "leave blank to keep" convention as the model keys above; the badge
  // says whether an entry type simply won't work without it.
  // The MCP tools read the env var first, so a key set in .env silently wins over
  // anything typed here — saying so beats a "saved" message that changes nothing.
  const envOverride = (col: string) => (process.env[col.toUpperCase()] ? `<span class="hint" style="color:var(--caution)">${escape(t(lang, "otherkeys.env_override", col.toUpperCase()))}</span>` : "");

  const otherKeyField = (col: string, labelKey: string, descKey: string, required: boolean) => `
    <div class="field" style="margin-top:16px">
      <label class="label">${escape(t(lang, labelKey))} <span class="tag ${required ? "admin" : "standard"}">${escape(t(lang, required ? "otherkeys.required" : "otherkeys.optional"))}</span></label>
      <input type="password" name="${col}" autocomplete="off" placeholder="${household[col] ? escape(t(lang, "settings.saved_placeholder")) : "…"}" />
      <span class="hint">${escape(t(lang, descKey))} ${escape(t(lang, "settings.leave_blank"))}</span>
      ${envOverride(col)}
    </div>`;

  return c.html(layout(t(lang, "dashboard.title"), `
    ${flash ? `<div class="flash">✓ ${escape(t(lang, "flash." + flash, c.req.query("n") || ""))}</div>` : ""}
    <div class="stack">
      <header>
        <h1 class="page-title">${escape(t(lang, "dashboard.title"))}</h1>
        <p class="page-sub">${escape(t(lang, "dashboard.subtitle"))}</p>
      </header>

      <section>
        ${sectionHead(t(lang, "dashboard.kicker_household"), t(lang, "members.title"), t(lang, "members.desc"),
          `<a href="/admin/users/new" class="btn primary sm">+ ${escape(t(lang, "members.add"))}</a>`)}
        <div class="card flush">${memberRows || `<div class="empty">${escape(t(lang, "members.empty"))}</div>`}</div>
      </section>

      <section id="sec-settings">
        ${sectionHead(t(lang, "dashboard.kicker_ai"), t(lang, "settings.title"), t(lang, "settings.desc"))}
        <form method="POST" action="/admin/settings" class="card pad">
          <div class="field"><label class="label">${escape(t(lang, "settings.household_name"))}</label>
            <input type="text" name="name" value="${escape(household.name)}" /></div>
          <div class="field" style="margin-top:16px"><label class="label">${escape(t(lang, "settings.anthropic_key"))}</label>
            <input type="password" name="api_key" autocomplete="off" placeholder="${household.api_key ? escape(t(lang, "settings.saved_placeholder")) : "sk-ant-…"}" />
            <span class="hint">${escape(t(lang, "settings.leave_blank"))} ${household.api_key ? escape(t(lang, "settings.key_is_set")) : escape(t(lang, "settings.no_key_echo"))}</span></div>
          <!-- fal.ai image-gen key hidden for the v1 release (feature unpolished); backend + save handler retained. -->
          <div class="grid2" style="margin-top:16px">
            <div class="field"><label class="label">${escape(t(lang, "settings.openai_key"))}</label>
              <input type="password" name="openai_api_key" autocomplete="off" placeholder="${household.openai_api_key ? escape(t(lang, "settings.saved_placeholder")) : "sk-…"}" />
              <span class="hint">${escape(t(lang, "settings.leave_blank"))}</span></div>
            <div class="field"><label class="label">${escape(t(lang, "settings.mistral_key"))}</label>
              <input type="password" name="mistral_api_key" autocomplete="off" placeholder="${household.mistral_api_key ? escape(t(lang, "settings.saved_placeholder")) : "…"}" />
              <span class="hint">${escape(t(lang, "settings.leave_blank"))}</span></div>
          </div>
          <div class="grid2" style="margin-top:16px">
            <div class="field"><label class="label">${escape(t(lang, "settings.zai_key"))}</label>
              <input type="password" name="zai_api_key" autocomplete="off" placeholder="${household.zai_api_key ? escape(t(lang, "settings.saved_placeholder")) : "…"}" />
              <span class="hint">${escape(t(lang, "settings.leave_blank"))}</span></div>
            <div class="field"><label class="label">${escape(t(lang, "settings.scaleway_key"))}</label>
              <input type="password" name="scaleway_api_key" autocomplete="off" placeholder="${household.scaleway_api_key ? escape(t(lang, "settings.saved_placeholder")) : "…"}" />
              <span class="hint">${escape(t(lang, "settings.leave_blank"))}</span></div>
          </div>
          <div class="grid2" style="margin-top:16px">
            <div class="field"><label class="label">${escape(t(lang, "settings.scaleway_project"))}</label>
              <input type="text" name="scaleway_project_id" class="mono" value="${escape(household.scaleway_project_id || "")}" placeholder="00000000-0000-0000-0000-000000000000" />
              <span class="hint">${escape(t(lang, "settings.scaleway_project_hint"))}</span></div>
          </div>
          <div class="grid2" style="margin-top:16px">
            <div class="field"><label class="label">${escape(t(lang, "settings.ollama_host"))}</label>
              <input type="text" name="ollama_host" class="mono" value="${escape(household.ollama_host || "http://localhost:11434")}" /></div>
            <div class="field"><label class="label">${escape(t(lang, "settings.default_model"))}</label>
              <select name="default_model">${modelOptions}</select>
              <span class="hint">${escape(t(lang, "settings.default_model_hint"))}</span></div>
          </div>
          <div class="grid2" style="margin-top:16px">
            <div class="field" style="max-width:200px"><label class="label">${escape(t(lang, "settings.max_tokens"))}</label>
              <input type="number" name="max_tokens" value="${household.max_tokens}" min="256" max="200000" /></div>
            <div class="field"><label class="label">${escape(t(lang, "settings.everyday_thinking"))}</label>
              <select name="everyday_thinking">
                ${[["", "auto"], ["0", "off"], ["1", "on"]].map(([v, k]) =>
                  `<option value="${v}"${(household.everyday_thinking == null ? "" : String(household.everyday_thinking)) === v ? " selected" : ""}>${escape(t(lang, `settings.thinking.${k}`))}</option>`).join("")}
              </select>
              <span class="hint">${escape(t(lang, "settings.everyday_thinking_hint"))}</span></div>
          </div>
          <div class="grid2" style="margin-top:16px">
            <div class="field" style="max-width:200px"><label class="label">${escape(t(lang, "settings.spend_cap_daily"))}</label>
              <input type="number" name="spend_cap_daily_usd" min="0" step="0.01" value="${household.spend_cap_daily_usd ?? ""}" placeholder="—" />
              <span class="hint">${escape(t(lang, "settings.spend_cap_daily_hint"))}</span></div>
            <div class="field" style="max-width:200px"><label class="label">${escape(t(lang, "settings.spend_cap_system"))}</label>
              <input type="number" name="spend_cap_system_daily_usd" min="0" step="0.01" value="${household.spend_cap_system_daily_usd ?? ""}" placeholder="—" />
              <span class="hint">${escape(t(lang, "settings.spend_cap_system_hint", spentTodayUsd(SYSTEM_SPENDER).toFixed(2), spentMonthUsd(SYSTEM_SPENDER).toFixed(2)))}</span></div>
          </div>
          <div class="grid2" style="margin-top:16px">
            <div class="field" style="max-width:200px"><label class="label">${escape(t(lang, "settings.opens_min_days"))}</label>
              <input type="number" name="maurice_opens_min_days" min="0" step="1" value="${household.maurice_opens_min_days ?? ""}" placeholder="${DEFAULT_MIN_DAYS}" />
              <span class="hint">${escape(t(lang, "settings.opens_min_days_hint", String(DEFAULT_MIN_DAYS)))}</span></div>
          </div>
          <div class="grid-actions"><button type="submit" class="btn primary">${escape(t(lang, "settings.save"))}</button></div>
        </form>
      </section>

      <section id="sec-reading">
        ${sectionHead(t(lang, "dashboard.kicker_ai"), "Reading", "The shared Calibre library the reading features serve.")}
        <div class="card pad">
          <div class="field"><label class="label">Calibre library</label>
            <div class="mono" style="opacity:.8">${escape(getDefaultLibrary(getAdminSession(c)!.userId)?.library_root || "— not configured —")}</div>
          </div>
          <div class="grid-actions"><a href="/admin/library" class="btn ghost sm">Configure library</a></div>
        </div>
      </section>

      <section>
        ${sectionHead(t(lang, "dashboard.kicker_models"), t(lang, "models.title"), t(lang, "models.desc"))}
        <div class="card flush">
          <div class="model-head ${olla.connected ? "ok" : "caution"}">
            ${headIcon("ollama", "▦")}
            <div class="head-main">
              <div class="head-title">Ollama
                <span class="status-dot" style="color:${olla.connected ? "var(--ok)" : "var(--caution)"}"><span class="dotmark" style="background:${olla.connected ? "var(--ok)" : "var(--caution)"}"></span>${olla.connected ? escape(t(lang, "settings.connected")) : escape(t(lang, "models.not_reachable"))}</span></div>
              <div class="head-meta">${olla.connected
                ? `${escape(olla.host)}${olla.version ? ` · v${escape(olla.version)}` : ""} · ${t(lang, "models.n_models", local.length)}${scanned ? ` · ${t(lang, "models.scanned_at", escape(scanned))}` : ` · ${escape(t(lang, "models.not_scanned"))}`}`
                : t(lang, "models.tried", escape(olla.host))}</div>
            </div>
            ${ramGauge}
            <form method="POST" action="/admin/models/rescan" class="inline"><button class="btn default sm">↻ ${escape(t(lang, "models.rescan"))}</button></form>
          </div>
          ${ollamaBody}
        </div>
        ${cloudCards}
      </section>

      <section id="sec-access">
        ${sectionHead(t(lang, "dashboard.kicker_access"), t(lang, "access.title"), t(lang, "access.desc"))}
        <form method="POST" action="/admin/access">
          <div class="card flush">
            ${matrix}
            <div class="matrix-actions"><button type="submit" class="btn primary sm">${escape(t(lang, "access.save"))}</button></div>
          </div>
        </form>
        <div class="legend">
          <span><span class="sw" style="background:var(--cloud)"></span> ${escape(t(lang, "access.legend_cloud"))}</span>
          <span><span class="sw" style="background:var(--ok)"></span> ${escape(t(lang, "access.legend_local"))}</span>
          <span><span class="star">★</span> ${escape(t(lang, "access.household_default"))}</span>
        </div>
      </section>

      <section id="sec-other-keys">
        ${sectionHead(t(lang, "dashboard.kicker_keys"), t(lang, "otherkeys.title"), t(lang, "otherkeys.desc"))}
        <form method="POST" action="/admin/other-keys" class="card pad">
          ${otherKeyField("tmdb_api_key", "otherkeys.tmdb", "otherkeys.tmdb_desc", true)}
          ${otherKeyField("google_books_api_key", "otherkeys.google_books", "otherkeys.google_books_desc", false)}
          <div class="field" style="margin-top:16px">
            <label class="label">${escape(t(lang, "otherkeys.podcastindex"))} <span class="tag standard">${escape(t(lang, "otherkeys.optional"))}</span></label>
            <div class="grid2">
              <div class="field"><input type="password" name="podcastindex_api_key" autocomplete="off" placeholder="${household.podcastindex_api_key ? escape(t(lang, "settings.saved_placeholder")) : escape(t(lang, "otherkeys.podcastindex"))}" /></div>
              <div class="field"><input type="password" name="podcastindex_api_secret" autocomplete="off" placeholder="${household.podcastindex_api_secret ? escape(t(lang, "settings.saved_placeholder")) : escape(t(lang, "otherkeys.podcastindex_secret"))}" /></div>
            </div>
            <span class="hint">${escape(t(lang, "otherkeys.podcastindex_desc"))} ${escape(t(lang, "settings.leave_blank"))}</span>
            ${envOverride("podcastindex_api_key")}${envOverride("podcastindex_api_secret")}
          </div>
          <div class="field" style="margin-top:16px">
            <label class="label">${escape(t(lang, "otherkeys.igdb"))} <span class="tag standard">${escape(t(lang, "otherkeys.optional"))}</span></label>
            <div class="grid2">
              <div class="field"><input type="password" name="igdb_client_id" autocomplete="off" placeholder="${household.igdb_client_id ? escape(t(lang, "settings.saved_placeholder")) : escape(t(lang, "otherkeys.igdb_client_id"))}" /></div>
              <div class="field"><input type="password" name="igdb_client_secret" autocomplete="off" placeholder="${household.igdb_client_secret ? escape(t(lang, "settings.saved_placeholder")) : escape(t(lang, "otherkeys.igdb_client_secret"))}" /></div>
            </div>
            <span class="hint">${escape(t(lang, "otherkeys.igdb_desc"))} ${escape(t(lang, "settings.leave_blank"))}</span>
            ${envOverride("igdb_client_id")}${envOverride("igdb_client_secret")}
          </div>
          <p class="sec-desc" style="margin-top:18px">${escape(t(lang, "otherkeys.no_key_needed"))}</p>
          <div class="grid-actions"><button type="submit" class="btn primary">${escape(t(lang, "otherkeys.save"))}</button></div>
        </form>
      </section>

      <section id="sec-ancillary">
        ${sectionHead(t(lang, "dashboard.kicker_advanced"), t(lang, "ancillary.section_title"), t(lang, "ancillary.section_desc"))}
        ${ancillaryCard(lang)}
      </section>

      <section id="sec-docs">
        ${sectionHead(t(lang, "dashboard.kicker_advanced"), t(lang, "docs.title"), t(lang, "docs.desc"))}
        ${docsCard(lang)}
      </section>

      <section id="sec-corpus">
        ${sectionHead(t(lang, "dashboard.kicker_advanced"), t(lang, "corpus.title"), t(lang, "corpus.desc"))}
        ${corpusCard(lang)}
      </section>

      <section id="sec-briefs">
        ${sectionHead(t(lang, "dashboard.kicker_advanced"), t(lang, "briefs.title"), t(lang, "briefs.desc"))}
        ${briefsCard(lang)}
      </section>

      <section id="sec-archive">
        ${sectionHead(t(lang, "dashboard.kicker_archive"), t(lang, "archive.title"), t(lang, "archive.desc"))}
        <div class="card pad">
          <a href="/admin/export" class="btn primary">${escape(t(lang, "archive.export"))}</a>
          <span class="hint">${escape(t(lang, "archive.hint"))}</span>
        </div>
      </section>
    </div>`, true, adminName(c), lang));
});

/** A posted spending cap: "" → null (no cap), a non-negative number → itself,
 *  anything else → undefined (leave the stored value alone). */
function parseCapUsd(raw: unknown): number | null | undefined {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// ── Maurice Maurice's documentation ─────────────────────────────
// Which set the built-in persona reads and how fresh it is; the button asks
// the published repo now rather than waiting for the daily check.
function docsCard(lang: string): string {
  const docs = docsStatus();
  const on = !!docsUrl();
  const checked = on
    ? docs.last_check_at
      ? t(lang, "docs.last_check", docs.last_check_at.slice(0, 16).replace("T", " "))
      : t(lang, "docs.never_checked")
    : t(lang, "docs.off");
  return `
        <div class="card pad">
          <div class="field">
            <label class="label">${escape(docs.generated_at ? t(lang, "docs.dated", docs.generated_at.slice(0, 10)) : t(lang, "docs.undated"))}</label>
            <span class="hint">${escape(t(lang, "docs.source_" + docs.source))} · ${escape(checked)}</span>
            ${docs.last_error ? `<span class="hint" style="color:var(--caution)">${escape(t(lang, "docs.last_error", docs.last_error))}</span>` : ""}
          </div>
          ${on ? `<div class="grid-actions"><form method="POST" action="/admin/docs/refresh" class="inline"><button type="submit" class="btn default sm">↻ ${escape(t(lang, "docs.check_now"))}</button></form></div>` : ""}
        </div>`;
}

web.post("/docs/refresh", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const outcome = await refreshDocs();
  const msg = { refreshed: "docs_refreshed", unchanged: "docs_up_to_date", failed: "docs_refresh_failed", off: "docs_refresh_off" }[outcome];
  return c.redirect(`/admin/dashboard?msg=${msg}#sec-docs`);
});

// ── The search corpus ───────────────────────────────────────────
// The nightly reconciliation (services/corpusNightly.ts): when it last ran,
// what it did, and a button to run it now. The run is not awaited — on a
// household with years of conversations it takes minutes — the card says
// "running" until it is done.
function corpusCard(lang: string): string {
  const s = corpusNightlyStatus();
  const when = s.last_run_at
    ? t(lang, "corpus.last_run", s.last_run_at.slice(0, 16).replace("T", " "))
    : t(lang, "corpus.never_run");
  const outcome = s.last_outcome ? t(lang, "corpus.outcome_" + s.last_outcome) : "";
  const stats = s.last_stats
    ? t(lang, "corpus.stats", String(s.last_stats.conversations), String(s.last_stats.chunks_written), String(s.last_stats.pruned))
    : "";
  return `
        <div class="card pad">
          <div class="field">
            <label class="label">${escape(s.running ? t(lang, "corpus.running") : s.on ? t(lang, "corpus.nightly_on") : t(lang, "corpus.off"))}</label>
            <span class="hint">${escape(when)}${outcome ? ` · ${escape(outcome)}` : ""}${stats ? ` · ${escape(stats)}` : ""}</span>
            ${s.last_error ? `<span class="hint" style="color:var(--caution)">${escape(t(lang, "corpus.last_error", s.last_error))}</span>` : ""}
          </div>
          <div class="grid-actions"><form method="POST" action="/admin/corpus/reconcile" class="inline"><button type="submit" class="btn default sm"${s.running ? " disabled" : ""}>↻ ${escape(t(lang, "corpus.reconcile_now"))}</button></form></div>
        </div>`;
}

web.post("/corpus/reconcile", (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const already = corpusNightlyStatus().running;
  reconcileCorpus().catch(() => {});
  return c.redirect(`/admin/dashboard?msg=${already ? "corpus_reconcile_running" : "corpus_reconcile_started"}#sec-corpus`);
});

// ── The domain briefs ───────────────────────────────────────────
// The night's other job (services/domainBriefs.ts): when the briefs were last
// rewritten, what it did and cost, and a button to run it now. Not awaited —
// one model call per domain with something new.
function briefsCard(lang: string): string {
  const s = briefsNightlyStatus();
  const when = s.last_run_at
    ? t(lang, "briefs.last_run", s.last_run_at.slice(0, 16).replace("T", " "))
    : t(lang, "briefs.never_run");
  const outcome = s.last_outcome ? t(lang, "briefs.outcome_" + s.last_outcome) : "";
  const stats = s.last_stats
    ? t(lang, "briefs.stats", String(s.last_stats.written), String(s.last_stats.unchanged), String(s.last_stats.failed), String(s.last_stats.domains), s.last_stats.cost_usd.toFixed(4))
    : "";
  return `
        <div class="card pad">
          <div class="field">
            <label class="label">${escape(s.running ? t(lang, "briefs.running") : s.on ? t(lang, "briefs.nightly_on") : t(lang, "briefs.off"))}</label>
            <span class="hint">${escape(when)}${outcome ? ` · ${escape(outcome)}` : ""}${stats ? ` · ${escape(stats)}` : ""}</span>
            ${s.last_error ? `<span class="hint" style="color:var(--caution)">${escape(t(lang, "briefs.last_error", s.last_error))}</span>` : ""}
            <span class="hint">${escape(t(lang, "briefs.spent", spentTodayUsd(SYSTEM_SPENDER).toFixed(2), spentMonthUsd(SYSTEM_SPENDER).toFixed(2)))}</span>
          </div>
          <div class="grid-actions"><form method="POST" action="/admin/briefs/run" class="inline"><button type="submit" class="btn default sm"${s.running ? " disabled" : ""}>↻ ${escape(t(lang, "briefs.run_now"))}</button></form></div>
        </div>`;
}

web.post("/briefs/run", (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const already = briefsNightlyStatus().running;
  runDomainBriefs().catch(() => {});
  return c.redirect(`/admin/dashboard?msg=${already ? "briefs_running" : "briefs_started"}#sec-briefs`);
});

// ── Export (GET) ────────────────────────────────────────────────
// The household archive from the console — the same stream as
// GET /api/admin/export, behind the admin cookie instead of a bearer token.
// See docs/household-archive.md.
web.get("/export", (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  try {
    return exportResponse();
  } catch (e: any) {
    console.error(`[archive] export refused: ${e?.message ?? e}`);
    return c.text(t(langOf(c), "archive.failed", e instanceof ArchiveError ? e.message : ""), 500);
  }
});

// ── Settings (POST) ─────────────────────────────────────────────
web.post("/settings", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const form = await c.req.parseBody();
  const sets: string[] = [];
  const params: any[] = [];
  const put = (col: string, v: any) => { sets.push(`${col} = ?`); params.push(v); };
  if (form.name) put("name", (form.name as string).trim());
  if (form.api_key && (form.api_key as string).trim()) put("api_key", (form.api_key as string).trim());
  if (form.openai_api_key && (form.openai_api_key as string).trim()) put("openai_api_key", (form.openai_api_key as string).trim());
  if (form.mistral_api_key && (form.mistral_api_key as string).trim()) put("mistral_api_key", (form.mistral_api_key as string).trim());
  if (form.zai_api_key && (form.zai_api_key as string).trim()) put("zai_api_key", (form.zai_api_key as string).trim());
  if (form.scaleway_api_key && (form.scaleway_api_key as string).trim()) put("scaleway_api_key", (form.scaleway_api_key as string).trim());
  // Not a secret, so unlike the keys an emptied field means "organization-wide".
  if (form.scaleway_project_id !== undefined) {
    const pid = (form.scaleway_project_id as string).trim();
    if (pid === "" || /^[0-9a-f-]{36}$/i.test(pid)) put("scaleway_project_id", pid || null);
  }
  if (form.fal_api_key && (form.fal_api_key as string).trim()) put("fal_api_key", (form.fal_api_key as string).trim());
  if (form.ollama_host) put("ollama_host", (form.ollama_host as string).trim().replace(/\/+$/, ""));
  if (form.default_model && getModel((form.default_model as string).trim())) put("default_model", (form.default_model as string).trim());
  if (form.max_tokens) put("max_tokens", parseInt(form.max_tokens as string) || 4096);
  // A select always posts: "" is the provider's default, "0"/"1" a choice.
  if (form.everyday_thinking !== undefined) {
    const v = String(form.everyday_thinking);
    if (v === "" || v === "0" || v === "1") put("everyday_thinking", v === "" ? null : Number(v));
  }
  if (sets.length) db.run(`UPDATE households SET ${sets.join(", ")} WHERE id = 'default'`, params);
  // A number input always posts: "" clears the household's own cap.
  if (form.spend_cap_daily_usd !== undefined) {
    const cap = parseCapUsd(form.spend_cap_daily_usd);
    if (cap !== undefined) setHouseholdDailyCap(cap);
  }
  if (form.spend_cap_system_daily_usd !== undefined) {
    const cap = parseCapUsd(form.spend_cap_system_daily_usd);
    if (cap !== undefined) setSystemDailyCap(cap);
  }
  // Days between two conversations Maurice opens for one member: "" = the default.
  if (form.maurice_opens_min_days !== undefined) {
    const raw = String(form.maurice_opens_min_days ?? "").trim();
    if (raw === "") setOpensMinDays(null);
    else if (/^\d+$/.test(raw)) setOpensMinDays(Number(raw));
  }
  return c.redirect("/admin/dashboard?msg=settings_saved#sec-settings");
});

// ── Ancillary models (POST) ─────────────────────────────────────
web.post("/ancillary-models", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const form = await c.req.parseBody();
  const ok = configuredProviders();
  // A pin has to be callable now; a model without a key would only fall back
  // silently, and the admin would think the pin took.
  const callable = (id: string) => { const m = getModel(id); return !!m && ok.has(m.provider); };
  const hh = String(form.ancillary_model ?? "").trim();
  if (hh && callable(hh)) setHouseholdAncillaryModel(hh);
  for (const inv of presentInvocations()) {
    const v = String(form[`pin:${inv.id}`] ?? "").trim();
    const model = v && callable(v) ? v : null;
    // Saving the form as it stands is agreement, not a decision: a value that
    // matches the advice stays "auto" and keeps following it, while anything
    // else is the admin's and is never moved again.
    setPinnedModel(inv.id, model, model && model === recommendedModel(inv.id) ? "auto" : "admin");
  }
  return c.redirect("/admin/dashboard?msg=settings_saved#sec-ancillary");
});

// ── Ancillary models: back to the provider range (POST) ─────────
// One button rather than twenty-two dropdowns, for the common case: put every
// function back on its tier's model in the household's range.
web.post("/ancillary-models/range", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const changed = applyRecommendedPins();
  return c.redirect(`/admin/dashboard?msg=${changed.length ? "ancillary_range" : "settings_saved"}#sec-ancillary`);
});

// ── Other API keys (POST) ───────────────────────────────────────
// Metadata/cover-art keys for the garden tools. Stored on the household row so
// the Python MCP tools can read them out of maurice.db — no .env round-trip.
const OTHER_KEY_COLUMNS = [
  "tmdb_api_key",
  "google_books_api_key",
  "podcastindex_api_key",
  "podcastindex_api_secret",
  "igdb_client_id",
  "igdb_client_secret",
] as const;

web.post("/other-keys", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const form = await c.req.parseBody();
  const sets: string[] = [];
  const params: any[] = [];
  for (const col of OTHER_KEY_COLUMNS) {
    const v = ((form[col] as string) || "").trim();
    if (v) { sets.push(`${col} = ?`); params.push(v); }
  }
  if (sets.length) db.run(`UPDATE households SET ${sets.join(", ")} WHERE id = 'default'`, params);
  return c.redirect("/admin/dashboard?msg=other_keys_saved#sec-other-keys");
});

// ── Models: rescan / add / delete ───────────────────────────────
web.post("/models/rescan", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const res = await discover();
  db.run(`UPDATE households SET ollama_scanned_at = datetime('now') WHERE id = 'default'`);
  return c.redirect(res.connected ? `/admin/dashboard?msg=scanned_models&n=${res.count}` : "/admin/dashboard?msg=ollama_not_reachable");
});

const PROVIDER_LABEL: Record<string, string> = { ollama: "On-device", openai: "OpenAI", mistral: "Mistral", zai: "Z.ai", scaleway: "Scaleway", anthropic: "Anthropic" };
const PROVIDER_VENDOR: Record<string, string> = { ollama: "Ollama", openai: "OpenAI", mistral: "Mistral", zai: "Z.ai", scaleway: "Scaleway", anthropic: "Anthropic" };

web.get("/models/new", (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const lang = langOf(c);
  const error = c.req.query("error");
  const provider = c.req.query("provider") || "ollama";
  const isLocal = provider === "ollama";
  const label = isLocal ? t(lang, "models.provider_ondevice") : (PROVIDER_LABEL[provider] || provider);
  const idPlaceholder = isLocal ? "phi4:14b" : provider === "openai" ? "gpt-4o" : provider === "mistral" ? "mistral-large-latest" : provider === "zai" ? "glm-5.3" : provider === "scaleway" ? "mistral-small-3.2-24b-instruct-2506" : "claude-…";
  return c.html(layout(t(lang, "models.new_title"), `
    <form method="POST" action="/admin/models/new">
      <input type="hidden" name="provider" value="${escape(provider)}" />
      <div class="card dialog">
        <div class="dialog-head"><div><div class="eyebrow">${escape(label)}</div><div class="ttl">${isLocal ? escape(t(lang, "models.add_manual")) : escape(t(lang, "models.add_provider", label))}</div></div></div>
        <div class="dialog-body">
          <p class="sec-desc" style="margin:0">${isLocal
            ? t(lang, "models.new_desc_local")
            : t(lang, "models.new_desc_cloud", escape(label), escape(idPlaceholder))}</p>
          ${error ? `<p class="error">${escape(t(lang, "models." + error))}</p>` : ""}
          <div class="grid3">
            <div class="field"><label class="label">${isLocal ? escape(t(lang, "models.ollama_tag")) : escape(t(lang, "models.model_id"))}</label><input type="text" name="id" class="mono" placeholder="${escape(idPlaceholder)}" required /></div>
            <div class="field"><label class="label">${escape(t(lang, "common.display_name"))}</label><input type="text" name="name" placeholder="${isLocal ? "Phi-4 14B" : "GPT-4o"}" required /></div>
            <div class="field"><label class="label">${isLocal ? escape(t(lang, "models.ram_gb")) : escape(t(lang, "models.context_k"))}</label><input type="text" name="${isLocal ? "ram" : "ctx"}" class="mono" placeholder="${isLocal ? "9" : "128"}" /></div>
          </div>
        </div>
        <div class="dialog-foot">
          <a href="/admin/dashboard" class="btn ghost">${escape(t(lang, "common.cancel"))}</a>
          <button type="submit" class="btn accent">+ ${escape(t(lang, "models.add_model"))}</button>
        </div>
      </div>
    </form>`, true, adminName(c), lang));
});
web.post("/models/new", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const form = await c.req.parseBody();
  const provider = (form.provider as string) || "ollama";
  const id = (form.id as string)?.trim();
  const name = (form.name as string)?.trim();
  if (!id || !name) return c.redirect(`/admin/models/new?provider=${provider}&error=err_id_name_required`);
  if (provider === "ollama") {
    addModel({ id, name, tier: "local", vendor: "Ollama", provider: "ollama", ctx: 8, ram: parseInt(form.ram as string) || 0, discovered: false, descr: "Added manually." });
  } else {
    addModel({ id, name, tier: "cloud", vendor: PROVIDER_VENDOR[provider] || provider, provider, ctx: parseInt(form.ctx as string) || 128, discovered: false, descr: "Added manually." });
  }
  return c.redirect("/admin/dashboard?msg=model_added");
});
web.post("/models/:id/ctx", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const form = await c.req.parseBody();
  const ctx = parseInt(form.ctx as string, 10);
  const ok = setModelCtx(c.req.param("id"), ctx);
  return c.redirect(ok ? "/admin/dashboard?msg=model_ctx_saved" : "/admin/dashboard?msg=model_ctx_invalid");
});
web.post("/models/:id/thinking", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const form = await c.req.parseBody();
  const ok = setModelThinking(c.req.param("id"), String(form.thinking ?? ""));
  return c.redirect(ok ? "/admin/dashboard?msg=model_thinking_saved" : "/admin/dashboard?msg=model_ctx_invalid");
});
web.post("/models/:id/delete", (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const m = getModel(c.req.param("id"));
  // Anything but a discovered Ollama model is removable (those reappear on scan).
  if (m && !(m.tier === "local" && m.discovered)) removeModel(m.id);
  return c.redirect("/admin/dashboard?msg=model_removed");
});

// ── Access matrix (POST) ────────────────────────────────────────
web.post("/access", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const fd = await c.req.formData();
  const pairs = fd.getAll("access").map(String); // "memberId|modelId"
  const byMember: Record<string, string[]> = {};
  for (const p of pairs) {
    const i = p.indexOf("|");
    if (i < 0) continue;
    const member = p.slice(0, i), model = p.slice(i + 1);
    (byMember[member] ||= []).push(model);
  }
  // The grid only shows models the household can call, and saving replaces a
  // member's whole list — so rows for the others are carried over rather than
  // wiped by a save they were never part of.
  const ok = configuredProviders();
  const shown = new Set(listModels().filter((m) => ok.has(m.provider)).map((m) => m.id));
  for (const u of listUsers()) {
    if (u.role === "admin") continue;
    replaceAccess(u.id, [...(byMember[u.id] || []), ...accessOutside(u.id, shown)]);
  }
  return c.redirect("/admin/dashboard?msg=access_saved#sec-access");
});

// ── Add member ──────────────────────────────────────────────────
web.get("/users/new", (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const lang = langOf(c);
  const error = c.req.query("error");
  const others = listUsers();
  const personas = listMaurices();
  return c.html(layout(t(lang, "members.add"), `
    <form method="POST" action="/admin/users/new">
      <div class="card dialog">
        <div class="dialog-head"><div><div class="eyebrow">${escape(t(lang, "members.new_eyebrow"))}</div><div class="ttl">${escape(t(lang, "members.new_title"))}</div></div></div>
        <div class="dialog-body">
          ${error ? `<p class="error">${escape(t(lang, "members." + error))}</p>` : ""}
          <div class="grid2">
            <div class="field"><label class="label">${escape(t(lang, "common.display_name"))}</label><input type="text" name="display_name" required autofocus /></div>
            <div class="field"><label class="label">${escape(t(lang, "members.handle"))}</label><input type="text" name="username" class="mono" required pattern="[a-z0-9_]+" title="${escape(t(lang, "members.handle_title"))}" /></div>
          </div>
          <div class="field"><label class="label">${escape(t(lang, "members.color"))}</label>
            <div class="swatches">${COLORS.map((col, i) => `<label class="swatch" style="color:${col}"><input type="radio" name="avatar_color" value="${col}" ${i === 0 ? "checked" : ""} /><span style="background:${col}"></span></label>`).join("")}</div></div>
          <div class="field"><label class="label">${escape(t(lang, "members.pin_optional"))}</label>
            <input type="text" name="pin" class="mono" placeholder="${escape(t(lang, "members.pin_placeholder"))}" inputmode="numeric" pattern="[0-9]{4,6}" /></div>
          <div class="field"><label class="label">${escape(t(lang, "members.profile"))}</label>
            <textarea name="profile_text" placeholder="${escape(t(lang, "members.profile_placeholder"))}"></textarea></div>
          <div class="field"><label class="label">${escape(t(lang, "members.role_label"))}</label>
            <select name="role" onchange="document.getElementById('guestblock').style.display=this.value==='guest'?'block':'none'">
              <option value="standard" selected>${escape(t(lang, "members.role_standard"))}</option>
              <option value="guest">${escape(t(lang, "members.role_guest"))}</option>
            </select>
            <span class="hint">${escape(t(lang, "members.role_hint"))}</span></div>
          <div id="guestblock" style="display:none">
            <div class="access-block">
              <div class="access-head"><span class="ttl2">${escape(t(lang, "guest.can_talk_to"))}</span></div>
              <div class="hint" style="margin-bottom:8px">${escape(t(lang, "guest.can_talk_to_hint"))}</div>
              <div class="chips">${others.map((u) => `<label class="chip"><input type="checkbox" name="contacts" value="${escape(u.id)}" /><span class="cdot"><span class="chk">✓</span></span><span class="clab">${escape(u.display_name)}</span></label>`).join("")}</div>
            </div>
            <div class="access-block">
              <div class="access-head"><span class="ttl2">${escape(t(lang, "guest.can_use"))}</span></div>
              <div class="hint" style="margin-bottom:8px">${escape(t(lang, "guest.can_use_hint"))}</div>
              <div class="chips">${personas.map((m) => `<label class="chip"><input type="checkbox" name="guest_maurices" value="${escape(m.id)}" /><span class="cdot"><span class="chk">✓</span></span><span class="clab">${escape(m.name)}</span></label>`).join("")}</div>
            </div>
          </div>
        </div>
        <div class="dialog-foot">
          <a href="/admin/dashboard" class="btn ghost">${escape(t(lang, "common.cancel"))}</a>
          <button type="submit" class="btn primary">${escape(t(lang, "members.add"))}</button>
        </div>
      </div>
    </form>`, true, adminName(c), lang));
});
web.post("/users/new", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const fd = await c.req.formData();
  const username = String(fd.get("username") || "").trim();
  const display_name = String(fd.get("display_name") || "").trim();
  const avatar_color = String(fd.get("avatar_color") || "") || "#2c5aa0";
  const pin = String(fd.get("pin") || "").trim() || undefined;
  const profile_text = String(fd.get("profile_text") || "").trim() || undefined;
  const role = String(fd.get("role") || "standard") === "guest" ? "guest" : "standard";
  if (!username || !display_name) return c.redirect("/admin/users/new?error=err_name_handle_required");
  try {
    const u = await createUser({ username, display_name, role, pin, avatar_color, profile_text });
    seedDefaultAccess(u.id);
    if (role === "guest") {
      setGuestContacts(u.id, fd.getAll("contacts").map(String));
      const selected = new Set(fd.getAll("guest_maurices").map(String));
      for (const m of listMaurices()) {
        if (selected.has(m.id)) setAccess(m.id, [...m.users, u.id]);
      }
    }
  } catch (err: any) {
    if (err.message?.includes("UNIQUE")) return c.redirect("/admin/users/new?error=err_handle_taken");
    throw err;
  }
  return c.redirect("/admin/dashboard?msg=member_added");
});

// ── Edit member (with model access) ─────────────────────────────
web.get("/users/:id/edit", (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const lang = langOf(c);
  const user = getUser(c.req.param("id"));
  if (!user) return c.redirect("/admin/dashboard");
  const error = c.req.query("error");
  const admin = user.role === "admin";
  const allowed = new Set(allowedModelIds(user.id));
  const expOK = canUseExperimental(user.id);
  // Same rule as the dashboard grid: only models the household can actually
  // call are offered, so a tick here means what it says.
  const keyed = configuredProviders();
  const models = listModels().filter((m) => keyed.has(m.provider));
  const cloud = models.filter((m) => m.tier === "cloud");
  const local = models.filter((m) => m.tier === "local");

  const chip = (m: Model) => {
    const on = admin || allowed.has(m.id);
    return `<label class="chip ${m.tier}"><input type="checkbox" name="access" value="${escape(m.id)}" ${on ? "checked" : ""} ${admin ? "disabled" : ""} /><span class="cdot"><span class="chk">${admin ? "🔒" : "✓"}</span></span><span class="clab">${escape(shortName(m))}</span></label>`;
  };

  // Guest reach: people (guest_contacts) + Maurices (each persona's own access).
  const isGuestUser = user.role === "guest";
  const contacts = new Set(getGuestContacts(user.id));
  const others = listUsers().filter((u) => u.id !== user.id);
  const personas = listMaurices();

  // Device invite code (separate card — can't nest forms inside the edit form).
  const invite = getInviteForUser(user.id);
  const inviteCard = `
    <div class="card pad" style="margin-top:18px">
      <div class="access-head"><span class="ttl2">${escape(t(lang, "invite.title"))}</span></div>
      <div class="hint" style="margin:6px 0 12px">${escape(t(lang, "invite.hint"))}</div>
      ${invite ? `
        <pre class="token" style="font-size:21px; letter-spacing:3px">${escape(formatInviteCode(invite.code))}</pre>
        <div class="hint" style="margin-top:6px">${escape(t(lang, "invite.expires", new Date(invite.expires_at).toLocaleDateString()))}</div>
        <div class="grid-actions" style="margin-top:12px; gap:10px">
          <form method="POST" action="/admin/users/${user.id}/invite" class="inline"><button class="btn default sm">${escape(t(lang, "invite.regenerate"))}</button></form>
          <form method="POST" action="/admin/users/${user.id}/invite/revoke" class="inline"><button class="btn danger sm">${escape(t(lang, "invite.revoke"))}</button></form>
        </div>` : `
        <form method="POST" action="/admin/users/${user.id}/invite"><button class="btn accent">${escape(t(lang, "invite.generate"))}</button></form>`}
    </div>`;

  return c.html(layout(t(lang, "members.edit_title", user.display_name), `
    <form method="POST" action="/admin/users/${user.id}/edit">
      <div class="card dialog">
        <div class="dialog-head">
          ${avatarHtml(user, 38)}
          <div><div class="eyebrow">${admin ? escape(t(lang, "members.role_admin")) : escape(t(lang, "members.role_member"))}</div><div class="ttl">${escape(user.display_name)}</div></div>
        </div>
        <div class="dialog-body">
          ${error ? `<p class="error">${escape(t(lang, "members." + error))}</p>` : ""}
          <div class="grid2">
            <div class="field"><label class="label">${escape(t(lang, "common.display_name"))}</label><input type="text" name="display_name" required value="${escape(user.display_name)}" /></div>
            <div class="field"><label class="label">${escape(t(lang, "members.handle_short"))}</label><input type="text" class="mono" value="@${escape(user.username)}" disabled /></div>
          </div>
          <div class="field"><label class="label">${escape(t(lang, "members.color"))}</label>
            <div class="swatches">${COLORS.map((col) => `<label class="swatch" style="color:${col}"><input type="radio" name="avatar_color" value="${col}" ${col === user.avatar_color ? "checked" : ""} /><span style="background:${col}"></span></label>`).join("")}</div></div>
          <div class="field"><label class="label">${user.has_pin ? escape(t(lang, "members.pin_edit_set")) : escape(t(lang, "members.pin_optional"))}</label>
            <input type="text" name="pin" class="mono" placeholder="${user.has_pin ? escape(t(lang, "members.pin_set_placeholder")) : escape(t(lang, "members.no_pin"))}" inputmode="numeric" /></div>
          <div class="field"><label class="label">${escape(t(lang, "members.profile"))}</label>
            <textarea name="profile_text">${escape(user.profile_text || "")}</textarea></div>
          <div class="access-block">
            <div class="access-head"><span class="ttl2">${escape(t(lang, "members.model_access"))}</span><span class="cnt ${admin ? "admin" : ""}">${admin ? escape(t(lang, "members.access_every")) : escape(t(lang, "members.access_count", allowed.size, models.length))}</span></div>
            ${cloud.length ? `<div class="chips-lab cloud">${escape(t(lang, "access.cloud"))}</div><div class="chips" style="margin-bottom:12px">${cloud.map(chip).join("")}</div>` : ""}
            ${local.length ? `<div class="chips-lab local">${escape(t(lang, "settings.on_device"))}</div><div class="chips">${local.map(chip).join("")}</div>` : `<div class="hint">${escape(t(lang, "members.no_local_rescan"))}</div>`}
          </div>
          <div class="grid2" style="margin-top:16px">
            <div class="field" style="max-width:200px"><label class="label">${escape(t(lang, "members.spend_cap_daily"))}</label>
              <input type="number" name="spend_cap_daily_usd" min="0" step="0.01" value="${memberDailyCap(user.id) ?? ""}" placeholder="—" />
              <span class="hint">${escape(t(lang, "members.spend_cap_daily_hint"))}</span></div>
            <div class="field"><label class="label">${escape(t(lang, "members.spent"))}</label>
              <div class="mono" style="padding:9px 0">${escape(t(lang, "members.spent_figures", spentTodayUsd(user.id).toFixed(2), spentMonthUsd(user.id).toFixed(2)))}</div></div>
          </div>
          <div class="access-block">
            <div class="access-head"><span class="ttl2">Experimental tools</span></div>
            <div class="hint" style="margin-bottom:8px">Unlocks the experimental tool families (calendar, health, research, the rest of the garden…) in this member's chats. Off by default.</div>
            <div class="chips"><label class="chip"><input type="checkbox" name="experimental_tools" ${expOK ? "checked" : ""} ${admin ? "disabled" : ""} /><span class="cdot"><span class="chk">${admin ? "🔒" : "✓"}</span></span><span class="clab">${admin ? "Always on (admin)" : "Enable experimental tools"}</span></label></div>
          </div>
          ${!admin ? `
          <div class="access-block">
            <div class="access-head"><span class="ttl2">${escape(t(lang, "members.is_child"))}</span></div>
            <div class="hint" style="margin-bottom:8px">${escape(t(lang, "members.is_child_hint"))}</div>
            <div class="chips"><label class="chip"><input type="checkbox" name="is_child" ${user.is_child ? "checked" : ""} /><span class="cdot"><span class="chk">✓</span></span><span class="clab">${escape(t(lang, "members.is_child_label"))}</span></label></div>
          </div>
          <div class="field"><label class="label">${escape(t(lang, "members.role_label"))}</label>
            <select name="role" onchange="document.getElementById('guestblock').style.display=this.value==='guest'?'block':'none'">
              <option value="standard" ${!isGuestUser ? "selected" : ""}>${escape(t(lang, "members.role_standard"))}</option>
              <option value="guest" ${isGuestUser ? "selected" : ""}>${escape(t(lang, "members.role_guest"))}</option>
            </select>
            <span class="hint">${escape(t(lang, "members.role_hint"))}</span></div>
          <div id="guestblock" style="display:${isGuestUser ? "block" : "none"}">
            <div class="access-block">
              <div class="access-head"><span class="ttl2">${escape(t(lang, "guest.can_talk_to"))}</span></div>
              <div class="hint" style="margin-bottom:8px">${escape(t(lang, "guest.can_talk_to_hint"))}</div>
              <div class="chips">${others.map((u) => `<label class="chip"><input type="checkbox" name="contacts" value="${escape(u.id)}" ${contacts.has(u.id) ? "checked" : ""} /><span class="cdot"><span class="chk">✓</span></span><span class="clab">${escape(u.display_name)}</span></label>`).join("")}</div>
            </div>
            <div class="access-block">
              <div class="access-head"><span class="ttl2">${escape(t(lang, "guest.can_use"))}</span></div>
              <div class="hint" style="margin-bottom:8px">${escape(t(lang, "guest.can_use_hint"))}</div>
              <div class="chips">${personas.map((m) => `<label class="chip"><input type="checkbox" name="guest_maurices" value="${escape(m.id)}" ${m.users.includes(user.id) ? "checked" : ""} /><span class="cdot"><span class="chk">✓</span></span><span class="clab">${escape(m.name)}</span></label>`).join("")}</div>
            </div>
          </div>` : ""}
        </div>
        <div class="dialog-foot">
          <a href="/admin/dashboard" class="btn ghost">${escape(t(lang, "common.cancel"))}</a>
          <button type="submit" class="btn primary">${escape(t(lang, "common.save_changes"))}</button>
        </div>
      </div>
    </form>
    ${inviteCard}
    ${renderImportSection(user, lang)}`, true, adminName(c), lang));
});

// ── Chat data-export import (proxied to the corpus tools) ────────────────────
const IMPORT_PROVIDER_KEYS = new Set(["anthropic", "chatgpt"]);

web.post("/users/:id/import", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const id = c.req.param("id");
  if (!getUser(id)) return c.json({ error: "not_found" }, 404);
  const provider = c.req.query("provider") || "anthropic";
  if (!IMPORT_PROVIDER_KEYS.has(provider)) return c.json({ error: "bad_provider" }, 400);
  let body: Record<string, any>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "bad_form" }, 400);
  }
  const file = body["file"];
  if (!(file instanceof File)) return c.json({ error: "no_file" }, 400);
  if (!file.name.toLowerCase().endsWith(".zip")) return c.json({ error: "not_zip" }, 400);
  const dest = join(uploadsDir(), `${provider}-${id}-${Date.now()}.zip`);
  await Bun.write(dest, file);
  try {
    const res = await corpusCall(id, "import_chat_export", { path: dest, provider, member_id: id });
    return c.json(res);
  } catch (e: any) {
    return c.json({ error: e?.message || "corpus_unreachable" }, 502);
  }
});
web.get("/users/:id/import/status", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const jobId = c.req.query("job");
  if (!jobId) return c.json({ error: "no_job" }, 400);
  try {
    return c.json(await corpusCall(c.req.param("id"), "import_status", { job_id: jobId }));
  } catch (e: any) {
    return c.json({ error: e?.message || "corpus_unreachable" }, 502);
  }
});
web.get("/users/:id/import/history", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const id = c.req.param("id");
  const provider = c.req.query("provider") || "anthropic";
  try {
    return c.json(await corpusCall(id, "import_history", { member_id: id, provider }));
  } catch (e: any) {
    return c.json({ error: e?.message || "corpus_unreachable" }, 502);
  }
});

web.post("/users/:id/edit", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const id = c.req.param("id");
  const user = getUser(id);
  if (!user) return c.redirect("/admin/dashboard");
  const fd = await c.req.formData();
  const updates: Record<string, any> = {};
  const dn = String(fd.get("display_name") || "").trim();
  if (dn) updates.display_name = dn;
  const col = String(fd.get("avatar_color") || "");
  if (col) updates.avatar_color = col;
  updates.profile_text = String(fd.get("profile_text") || "").trim() || null;
  const pinVal = String(fd.get("pin") || "").trim();
  if (pinVal === "clear") updates.pin = null;
  else if (/^\d{4,6}$/.test(pinVal)) updates.pin = pinVal;
  await updateUser(id, updates);
  // Every member, admins included: a cap is a choice about money, not access.
  if (fd.has("spend_cap_daily_usd")) {
    const cap = parseCapUsd(fd.get("spend_cap_daily_usd"));
    if (cap !== undefined) setMemberDailyCap(id, cap);
  }
  if (user.role !== "admin") {
    // Only callable models were offered, so keep the rest of this member's rows.
    const ok = configuredProviders();
    const shown = new Set(listModels().filter((m) => ok.has(m.provider)).map((m) => m.id));
    replaceAccess(id, [...fd.getAll("access").map(String), ...accessOutside(id, shown)]);
    setExperimentalAccess(id, fd.get("experimental_tools") != null);
    setUserChild(id, fd.get("is_child") != null);
    const newRole = String(fd.get("role") || "standard") === "guest" ? "guest" : "standard";
    setUserRole(id, newRole);
    if (newRole === "guest") {
      setGuestContacts(id, fd.getAll("contacts").map(String));
      // Sync persona access: this guest belongs to exactly the chosen personas.
      const selected = new Set(fd.getAll("guest_maurices").map(String));
      for (const m of listMaurices()) {
        const has = m.users.includes(id);
        const want = selected.has(m.id);
        if (has !== want) {
          setAccess(m.id, want ? [...m.users, id] : m.users.filter((u) => u !== id));
        }
      }
    } else {
      setGuestContacts(id, []); // demoted from guest — drop the contact list
    }
  }
  return c.redirect("/admin/dashboard?msg=member_updated");
});

// ── Invite code (device enrollment) ─────────────────────────────
web.post("/users/:id/invite", (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const id = c.req.param("id");
  if (!getUser(id)) return c.redirect("/admin/dashboard");
  createInviteCode(id);
  return c.redirect(`/admin/users/${id}/edit`);
});
web.post("/users/:id/invite/revoke", (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const id = c.req.param("id");
  revokeInvite(id);
  return c.redirect(`/admin/users/${id}/edit`);
});

// ── Delete member ───────────────────────────────────────────────
web.post("/users/:id/delete", (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const id = c.req.param("id");
  const session = getAdminSession(c)!;
  if (id === session.userId) return c.redirect("/admin/dashboard?msg=cannot_delete_self");
  deleteUser(id);
  return c.redirect("/admin/dashboard?msg=member_removed");
});

// ── API Tokens ──────────────────────────────────────────────────
web.get("/tokens", (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const lang = langOf(c);
  const session = getAdminSession(c)!;
  const tokens = listApiTokens(session.userId);
  const flash = c.req.query("msg");
  const newToken = c.req.query("new_token");
  const rows = tokens.map((tok) => `
    <div class="model-row">
      <div class="model-main"><div><span class="model-name">${escape(tok.label)}</span> <span class="tag standard">${escape(tok.scope)}</span></div>
        <div class="model-desc">${escape(t(lang, "tokens.last_used", tok.last_used_at ? tok.last_used_at : t(lang, "tokens.never")))} · ${escape(t(lang, "tokens.created", tok.created_at))}</div></div>
      <form method="POST" action="/admin/tokens/${tok.id}/revoke" class="inline" onsubmit="return confirm('${escape(t(lang, "tokens.confirm_revoke"))}')"><button class="btn danger sm">${escape(t(lang, "tokens.revoke"))}</button></form>
    </div>`).join("");
  return c.html(layout(t(lang, "tokens.title"), `
    ${flash ? `<div class="flash">✓ ${escape(t(lang, "flash." + flash))}</div>` : ""}
    ${newToken ? `<div class="card pad" style="margin-bottom:18px"><strong>${escape(t(lang, "tokens.new_token_notice"))}</strong><pre class="token">${escape(newToken)}</pre></div>` : ""}
    <section>
      ${sectionHead(t(lang, "tokens.kicker"), t(lang, "tokens.title"), t(lang, "tokens.desc"))}
      <form method="POST" action="/admin/tokens" class="card pad">
        <div class="grid2">
          <div class="field"><label class="label">${escape(t(lang, "tokens.label"))}</label><input type="text" name="label" required placeholder="${escape(t(lang, "tokens.label_placeholder"))}" /></div>
          <div class="field"><label class="label">${escape(t(lang, "tokens.scope"))}</label><select name="scope"><option value="full">${escape(t(lang, "tokens.scope_full"))}</option><option value="mcp">${escape(t(lang, "tokens.scope_mcp"))}</option><option value="health">${escape(t(lang, "tokens.scope_health"))}</option></select></div>
        </div>
        <div class="grid-actions"><button type="submit" class="btn primary">${escape(t(lang, "tokens.create"))}</button></div>
      </form>
      ${tokens.length ? `<div class="card flush" style="margin-top:18px">${rows}</div>` : `<p class="muted" style="margin-top:14px">${escape(t(lang, "tokens.empty"))}</p>`}
    </section>`, true, adminName(c), lang));
});
web.post("/tokens", async (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const session = getAdminSession(c)!;
  const form = await c.req.parseBody();
  const label = (form.label as string)?.trim();
  const scope = (form.scope as string) || "full";
  if (!label) return c.redirect("/admin/tokens?msg=label_required");
  if (!["mcp", "health", "full"].includes(scope)) return c.redirect("/admin/tokens?msg=invalid_scope");
  const { rawToken } = await createApiToken(session.userId, label, scope as "mcp" | "health" | "full");
  return c.redirect(`/admin/tokens?new_token=${encodeURIComponent(rawToken)}`);
});
web.post("/tokens/:id/revoke", (c) => {
  const redir = requireWebAdmin(c);
  if (redir) return redir;
  const session = getAdminSession(c)!;
  const revoked = revokeApiToken(c.req.param("id"), session.userId);
  return c.redirect(`/admin/tokens?msg=${revoked ? "token_revoked" : "token_not_found"}`);
});

export default web;
