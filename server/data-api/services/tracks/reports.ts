import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(process.cwd(), "..");
const tracksRoot = resolve(repoRoot, "tracks");
const plansDir = resolve(tracksRoot, "_plans");

// Cache track titles from track.json
const titleCache = new Map<string, string>();

async function readJson(path: string): Promise<any> {
  const content = await fs.readFile(path, "utf8");
  return JSON.parse(content);
}

export async function readTrackTitle(trackId: string): Promise<string> {
  if (titleCache.has(trackId)) {
    return titleCache.get(trackId)!;
  }
  const trackJsonPath = resolve(tracksRoot, trackId, "track.json");
  try {
    const data = await readJson(trackJsonPath);
    const title = data.title || trackId;
    titleCache.set(trackId, title);
    return title;
  } catch {
    titleCache.set(trackId, trackId);
    return trackId;
  }
}

type PlanIndexEntry = {
  planId: string;
  createdAt: string | null;
  startDate: string | null;
  endDate: string | null;
  tracks: { trackId: string; trackName: string; hasReport: boolean }[];
};

async function listPlansWithTracks(): Promise<PlanIndexEntry[]> {
  let files: string[];
  try {
    files = (await fs.readdir(plansDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const plans: PlanIndexEntry[] = [];
  for (const file of files) {
    try {
      const data = await readJson(resolve(plansDir, file));
      const planId = data.plan_id ?? file.replace(/\.json$/, "");
      const tracks: PlanIndexEntry["tracks"] = [];
      for (const entry of data.entries ?? []) {
        const title = await readTrackTitle(entry.track_id);
        const htmlPath = resolve(tracksRoot, entry.track_id, "reports", `${planId}.html`);
        let hasReport = false;
        try {
          await fs.access(htmlPath);
          hasReport = true;
        } catch {}
        tracks.push({ trackId: entry.track_id, trackName: title, hasReport });
      }
      plans.push({
        planId,
        createdAt: data.created_at ?? null,
        startDate: data.start_date ?? null,
        endDate: data.end_date ?? null,
        tracks,
      });
    } catch (err) {
      console.warn(`Failed to parse plan ${file}:`, err);
    }
  }
  plans.sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bTime - aTime;
  });
  return plans;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function navBarCss(): string {
  return `
.report-nav {
  position: fixed; top: 0; left: 0; right: 0; z-index: 9000;
  background: var(--paper, #fafaf8); border-bottom: 1px solid var(--paper-rule, #e0ddd6);
  font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif);
  font-size: 0.8125rem; opacity: 0.7; transition: opacity 0.15s;
}
.report-nav:hover { opacity: 1; }
.report-nav-inner {
  max-width: 1100px; margin: 0 auto;
  padding: 8px 2.5rem;
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
}
.report-nav-crumbs {
  display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;
  color: var(--ink-muted, #6b6b6b);
}
.report-nav-crumbs a {
  color: var(--link, #2c5282); text-decoration: none; font-weight: 500;
}
.report-nav-crumbs a:hover { text-decoration: underline; }
.report-nav-crumbs .sep { color: var(--ink-faint, #999); }
.report-nav-crumbs .current { color: var(--ink, #1a1a1a); font-weight: 600; }
.report-nav-links {
  display: flex; gap: 0.75rem;
}
.report-nav-links a {
  color: var(--ink-muted, #6b6b6b); text-decoration: none; font-weight: 500;
}
.report-nav-links a:hover { color: var(--ink, #1a1a1a); }
@media (max-width: 600px) {
  .report-nav { position: relative; opacity: 1; }
  .report-nav-inner { padding: 8px 1rem; flex-wrap: wrap; }
  .report-nav-crumbs { font-size: 0.75rem; }
  .report-nav-links { font-size: 0.75rem; }
  body { padding-top: 0 !important; }
}
@media (prefers-color-scheme: dark) {
  .report-nav { background: var(--paper, #1a1915); border-color: var(--paper-rule, #3a3830); }
  .report-nav-crumbs .current { color: var(--ink, #e8e6e1); }
}`;
}

type Breadcrumb = { label: string; href?: string };
type PrevNext = { prev?: { label: string; href: string }; next?: { label: string; href: string } };

function renderNavBar(breadcrumbs: Breadcrumb[], prevNext?: PrevNext): string {
  const crumbsHtml = breadcrumbs
    .map((crumb, i) => {
      const isLast = i === breadcrumbs.length - 1;
      const sep = i > 0 ? '<span class="sep">/</span>' : "";
      if (isLast) {
        return `${sep}<span class="current">${escapeHtml(crumb.label)}</span>`;
      }
      return `${sep}<a href="${escapeHtml(crumb.href || "#")}">${escapeHtml(crumb.label)}</a>`;
    })
    .join(" ");

  let linksHtml = '<a href="/articles">Articles</a><a href="/books">Books</a>';
  if (prevNext) {
    const parts: string[] = [];
    if (prevNext.prev) {
      parts.push(`<a href="${escapeHtml(prevNext.prev.href)}">&larr; ${escapeHtml(prevNext.prev.label)}</a>`);
    }
    if (prevNext.next) {
      parts.push(`<a href="${escapeHtml(prevNext.next.href)}">${escapeHtml(prevNext.next.label)} &rarr;</a>`);
    }
    linksHtml = parts.join("");
  }

  return `<nav class="report-nav"><div class="report-nav-inner"><div class="report-nav-crumbs">${crumbsHtml}</div><div class="report-nav-links">${linksHtml}</div></div></nav>`;
}

/** All report CSS combined — served from /reports/styles.css */
export function reportStylesCss(): string {
  return PAGE_CSS + "\n" + navBarCss() + "\n" + issueCss() + "\n" + articleVisualsCss();
}

function issueCss(): string {
  return `
/* Issue-level layout */
.issue-header { margin-bottom: 2.5rem; }
.issue-header h1 { font-size: clamp(2rem, 5vw, 2.5rem); line-height: 1.15;
  letter-spacing: -0.03em; margin-bottom: 0.5rem; }
.issue-meta { display: flex; gap: 1.5rem; flex-wrap: wrap;
  font-family: var(--font-sans); font-size: var(--step--2); color: var(--ink-muted); }
.inaugural-badge { background: var(--accent); color: var(--paper); padding: 0.15em 0.6em;
  border-radius: 4px; font-weight: 600; font-size: var(--step--2); }
.issue-toc { margin-bottom: 2.5rem; padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--paper-rule); }
.issue-toc ul { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.issue-toc a { font-family: var(--font-sans); font-size: var(--step--1); font-weight: 500;
  color: var(--ink-muted); text-decoration: none; padding: 0.25rem 0; display: block; }
.issue-toc a:hover { color: var(--ink); }
.toc-type { font-size: var(--step--2); font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--accent); margin-right: 0.5rem; }
/* Article sections */
.article-section { margin-bottom: 3rem; padding-bottom: 2rem;
  border-bottom: 1px solid var(--paper-rule); }
.article-section:last-of-type { border-bottom: none; }
.article-header { margin-bottom: 1.5rem; }
.article-header h2 { border: none; padding-top: 0; margin-top: 0.5rem; }
/* Deep Dive: drop cap on first paragraph */
.article-type-deep-dive .article-body > p:first-of-type::first-letter {
  font-size: 3.2em; float: left; font-weight: 700; line-height: 0.8;
  margin: 0.1em 0.12em 0 0; color: var(--ink); font-family: var(--font-serif); }
/* Practical Brief: compact styling */
.article-type-practical-brief .article-body { font-size: var(--step--1); }
.article-type-practical-brief .article-body h3 { font-size: var(--step-0);
  color: var(--accent); margin-top: 1.5rem; }
/* Signal Roundup: compact cards */
.article-type-signal-roundup .article-body { font-size: var(--step--1); }
.article-type-signal-roundup .article-body strong { color: var(--ink); }
/* Reflection: narrower, blockquote emphasis */
.article-type-reflection .article-body { max-width: 55ch; }
.article-type-reflection .article-body blockquote { font-size: var(--step-1);
  border-left-width: 4px; padding: 1.5rem 2rem; margin: 2rem 0; }
/* Field Note: small card */
.article-type-field-note { background: var(--paper-warm); padding: 1.5rem;
  border-radius: 8px; border-bottom: none; }
.article-type-field-note .article-body { font-size: var(--step--1);
  color: var(--ink-light); font-style: italic; }
/* Curated List: reading list with prominent links */
.article-type-curated-list .article-header h2 { font-size: var(--step-2); }
.article-type-curated-list .article-body { font-family: var(--font-sans); }
.article-type-curated-list .article-body ul { list-style: none; padding: 0;
  display: flex; flex-direction: column; gap: 0.75rem; }
.article-type-curated-list .article-body li { padding: 1rem 1.25rem;
  background: var(--paper-warm); border: 1px solid var(--paper-rule);
  border-radius: 8px; margin-bottom: 0; transition: border-color 0.15s; }
.article-type-curated-list .article-body li:hover { border-color: var(--accent); }
.article-type-curated-list .article-body li a { font-weight: 600;
  font-size: var(--step-0); color: var(--link); }
.article-type-curated-list .article-body li a:hover { color: var(--link-hover);
  text-decoration: underline; }
.article-type-curated-list .article-body p { font-size: var(--step--1);
  color: var(--ink-light); max-width: none; }
/* Evidence section */
.evidence-section { margin-top: 2rem; }
.evidence-section summary { font-family: var(--font-sans); font-size: var(--step--1);
  font-weight: 600; cursor: pointer; color: var(--ink-muted); padding: 0.5rem 0; }
.evidence-content { padding: 1rem; background: var(--paper-warm); border-radius: 8px;
  font-size: var(--step--1); margin-top: 0.5rem; }
/* Pipeline stats bar */
.pipeline-stats { display: flex; gap: 1.5rem; flex-wrap: wrap; align-items: center;
  font-family: var(--font-sans); font-size: var(--step--2); color: var(--ink-muted);
  margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--paper-rule);
  opacity: 0.7; }
.pipeline-stats:hover { opacity: 1; }
.stat-item { white-space: nowrap; }
.stat-total { font-weight: 600; }
@media (prefers-color-scheme: dark) {
  .badge-deep-dive { background: #7bb0d430; }
  .badge-practical-brief { background: #4abb7030; }
  .badge-reflection { background: #b080e030; }
}`;
}

function ensureCssLink(html: string): string {
  const link = '<link rel="stylesheet" href="/reports/styles.css" />';
  // If already has our link, skip
  if (html.includes("/reports/styles.css")) return html;
  // Insert before </head> if present
  const headClose = html.indexOf("</head>");
  if (headClose !== -1) {
    return html.slice(0, headClose) + link + "\n" + html.slice(headClose);
  }
  // Fallback: prepend
  return link + "\n" + html;
}

function injectNav(html: string, breadcrumbs: Breadcrumb[], prevNext?: PrevNext): string {
  const navHtml = renderNavBar(breadcrumbs, prevNext);
  const navStyle = `<style>${navBarCss()}</style>`;

  // Add external CSS link (existing inline styles stay — they may be page-specific)
  html = ensureCssLink(html);

  // Inject after <body> tag
  const bodyIdx = html.indexOf("<body");
  if (bodyIdx === -1) {
    return navStyle + navHtml + html;
  }
  const bodyCloseIdx = html.indexOf(">", bodyIdx);
  if (bodyCloseIdx === -1) {
    return html;
  }
  const insertPos = bodyCloseIdx + 1;
  return (
    html.slice(0, insertPos) +
    navStyle +
    navHtml +
    html.slice(insertPos)
  );
}

// ── Page rendering ──

const PAGE_CSS = `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --step--2: 0.75rem; --step--1: 0.875rem; --step-0: 1.0625rem;
  --step-1: 1.25rem; --step-2: 1.5rem; --step-3: 1.875rem;
  --step-4: 2.25rem; --step-5: 3rem;
  --font-serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, Consolas, monospace;
  --ink: #1a1a1a; --ink-light: #4a4a4a; --ink-muted: #6b6b6b; --ink-faint: #999;
  --paper: #fafaf8; --paper-warm: #f5f3ef; --paper-rule: #e0ddd6;
  --accent: #8b4513; --accent-light: #b8860b;
  --link: #2c5282; --link-hover: #1a365d;
  --measure: 65ch; --sidebar: 220px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #e8e6e1; --ink-light: #bbb8b0; --ink-muted: #8a8780; --ink-faint: #6b6860;
    --paper: #1a1915; --paper-warm: #22211c; --paper-rule: #3a3830;
    --accent: #d4a064; --accent-light: #e0c080;
    --link: #7bb0d4; --link-hover: #a0ccee;
  }
}
html { font-size: 100%; scroll-behavior: smooth;
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
body { font-family: var(--font-serif); font-size: var(--step-0);
  line-height: 1.65; color: var(--ink); background: var(--paper); padding-top: 40px; }
h1, h2, h3, h4, h5, h6 { font-family: var(--font-sans); font-weight: 700;
  line-height: 1.2; color: var(--ink); letter-spacing: -0.02em; }
h1 { font-size: var(--step-5); margin-bottom: 1rem; }
h2 { font-size: var(--step-3); margin-top: 2.5rem; margin-bottom: 1rem; }
h3 { font-size: var(--step-2); margin-top: 2rem; margin-bottom: 0.75rem; }
p { margin-bottom: 1rem; max-width: var(--measure); }
a { color: var(--link); text-decoration: none; text-underline-offset: 2px; }
a:hover { color: var(--link-hover); text-decoration: underline; }
ul, ol { padding-left: 1.4em; margin-bottom: 1rem; max-width: var(--measure); }
li { margin-bottom: 0.25rem; }
.page { min-height: 100vh; display: flex; flex-direction: column; }
.page-inner { max-width: 1100px; margin: 0 auto; padding: 2rem 2.5rem; flex: 1; }
.masthead { border-bottom: 1px solid var(--paper-rule); padding: 1.5rem 2.5rem; }
.masthead-inner { max-width: 780px; margin: 0 auto; display: flex;
  align-items: baseline; justify-content: space-between; }
.masthead-brand { font-family: var(--font-sans); font-size: var(--step--1);
  font-weight: 600; color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.12em; }
.masthead-date { font-family: var(--font-sans); font-size: var(--step--2);
  color: var(--ink-faint); letter-spacing: 0.04em; }
.article-wrap { max-width: 780px; margin: 0 auto; padding: 3rem 2.5rem 4rem; }
.article-wrap > h1:first-child { font-size: clamp(2rem, 5vw, 2.5rem);
  line-height: 1.15; letter-spacing: -0.03em; margin-bottom: 0.5rem; }
.page-footer { margin-top: auto; padding: 1.5rem 2.5rem;
  border-top: 1px solid var(--paper-rule); text-align: center;
  font-family: var(--font-sans); font-size: var(--step--2); color: var(--ink-faint); }
.plan-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1.5rem; margin-top: 2rem; }
.plan-card { background: var(--paper-warm); border: 1px solid var(--paper-rule);
  border-radius: 12px; padding: 1.5rem; text-decoration: none; color: inherit;
  transition: border-color 0.15s, box-shadow 0.15s; display: block; }
.plan-card:hover { border-color: var(--accent); box-shadow: 0 4px 16px rgba(0,0,0,0.06);
  text-decoration: none; }
.plan-card-date { font-family: var(--font-sans); font-size: var(--step--1);
  font-weight: 600; color: var(--ink); margin-bottom: 0.5rem; }
.plan-card-window { font-family: var(--font-sans); font-size: var(--step--2);
  color: var(--ink-muted); margin-bottom: 0.75rem; }
.plan-card-tracks { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.track-pill { font-family: var(--font-sans); font-size: var(--step--2); font-weight: 500;
  padding: 0.15em 0.6em; border-radius: 100px; border: 1px solid var(--paper-rule);
  color: var(--ink-muted); background: var(--paper); }
.track-pill.has-report { border-color: var(--accent); color: var(--accent); }
.prose { max-width: var(--measure); }
.prose > * + * { margin-top: 1rem; }
.prose > p:first-of-type::first-letter { font-size: 3.2em; float: left;
  font-weight: 700; line-height: 0.8; margin: 0.1em 0.12em 0 0;
  color: var(--ink); font-family: var(--font-serif); }
.article-type-badge { display: inline-block; font-family: var(--font-sans);
  font-size: var(--step--2); font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.08em; padding: 0.15em 0.6em; border-radius: 4px; }
.badge-deep-dive { background: #2c528220; color: var(--link); }
.badge-practical-brief { background: #22763820; color: #227638; }
.badge-signal-roundup { background: #8b451320; color: var(--accent); }
.badge-reflection { background: #6b3fa020; color: #6b3fa0; }
.badge-field-note { background: #5a5a5a20; color: var(--ink-muted); }
.badge-curated-list { background: #b8860b20; color: var(--accent-light); }
@media (prefers-color-scheme: dark) {
  .badge-deep-dive { background: #7bb0d430; }
  .badge-practical-brief { background: #4abb7030; }
  .badge-reflection { background: #b080e030; }
}
@media (max-width: 600px) {
  body { padding-top: 0; }
  .page-inner { padding: 1.5rem 1rem; }
  .plan-cards { grid-template-columns: 1fr; }
  h1 { font-size: var(--step-3); overflow-wrap: break-word; word-break: break-word; }
  h2 { font-size: var(--step-2); overflow-wrap: break-word; }
  p, blockquote, ul, ol { max-width: 100%; }
  .prose { max-width: 100%; }
  .article-wrap { padding: 1.5rem 1rem; }
  .masthead { padding: 1rem; }
}`;

export async function renderReportsIndex(): Promise<string> {
  const plans = await listPlansWithTracks();
  const cards = plans
    .map((plan) => {
      const dateLabel = formatDate(plan.createdAt) || plan.planId;
      const window = plan.startDate && plan.endDate ? `${plan.startDate} &rarr; ${plan.endDate}` : "";
      const pills = plan.tracks
        .map((t) => {
          const cls = t.hasReport ? "track-pill has-report" : "track-pill";
          return `<span class="${cls}">${escapeHtml(t.trackName)}</span>`;
        })
        .join("");
      return `<a class="plan-card" href="/reports/${escapeHtml(plan.planId)}">
  <div class="plan-card-date">${escapeHtml(dateLabel)}</div>
  <div class="plan-card-window">${window} &middot; ${plan.tracks.length} tracks</div>
  <div class="plan-card-tracks">${pills}</div>
</a>`;
    })
    .join("\n");

  const nav = renderNavBar([{ label: "All Reports" }]);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>All Reports — Akita Research</title>
  <link rel="stylesheet" href="/reports/styles.css" />
</head>
<body>
  ${nav}
  <div class="page">
    <div class="page-inner">
      <h1>Research Reports</h1>
      <p>Browse all research plans and their reports.</p>
      <div class="plan-cards">${cards}</div>
    </div>
    <footer class="page-footer">Generated by Akita Research Pipeline</footer>
  </div>
</body>
</html>`;
}

export async function renderDigestPage(planId: string): Promise<string | null> {
  // Try HTML digest first
  const htmlPath = resolve(tracksRoot, "_digests", `${planId}.html`);
  try {
    const html = await fs.readFile(htmlPath, "utf8");
    // Get plan tracks for prev/next nav
    const breadcrumbs: Breadcrumb[] = [
      { label: "All Reports", href: "/reports" },
      { label: formatDate(null) || planId },
    ];
    // Try to get a nicer date label
    try {
      const planData = await readJson(resolve(plansDir, `${planId}.json`));
      breadcrumbs[1].label = formatDate(planData.created_at) || planId;
    } catch {}
    return injectNav(html, breadcrumbs);
  } catch {}

  // Fallback: try markdown digest
  const mdPath = resolve(tracksRoot, "_digests", `${planId}.md`);
  try {
    const md = await fs.readFile(mdPath, "utf8");
    const breadcrumbs: Breadcrumb[] = [
      { label: "All Reports", href: "/reports" },
      { label: planId },
    ];
    // Render markdown as basic HTML
    const contentHtml = basicMarkdownToHtml(md);
    const nav = renderNavBar(breadcrumbs);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Digest ${escapeHtml(planId)} — Akita Research</title>
  <link rel="stylesheet" href="/reports/styles.css" />
</head>
<body>
  ${nav}
  <div class="page">
    <div class="page-inner prose">${contentHtml}</div>
    <footer class="page-footer">Generated by Akita Research Pipeline</footer>
  </div>
</body>
</html>`;
  } catch {}

  // Fallback: no digest exists — render a plan index with links to track reports
  try {
    const planData = await readJson(resolve(plansDir, `${planId}.json`));
    const entries: { track_id: string }[] = planData.entries || [];

    // Single track: redirect directly to its report
    if (entries.length === 1) {
      return `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/reports/${escapeHtml(planId)}/${escapeHtml(entries[0].track_id)}" /></head><body></body></html>`;
    }

    // Multiple tracks: show index page
    let dateLabel = planId;
    try {
      dateLabel = formatDate(planData.created_at) || planId;
    } catch {}

    const trackLinks: string[] = [];
    for (const entry of entries) {
      const title = await readTrackTitle(entry.track_id);
      const reportPath = resolve(tracksRoot, entry.track_id, "reports", `${planId}.html`);
      const mdReportPath = resolve(tracksRoot, entry.track_id, "reports", `${planId}.md`);
      let hasReport = false;
      try { await fs.access(reportPath); hasReport = true; } catch {}
      if (!hasReport) {
        try { await fs.access(mdReportPath); hasReport = true; } catch {}
      }
      const cls = hasReport ? "track-pill has-report" : "track-pill";
      if (hasReport) {
        trackLinks.push(`<a class="plan-card" href="/reports/${escapeHtml(planId)}/${escapeHtml(entry.track_id)}"><div class="plan-card-date">${escapeHtml(title)}</div></a>`);
      } else {
        trackLinks.push(`<div class="plan-card" style="opacity:0.5"><div class="plan-card-date">${escapeHtml(title)}</div><div class="plan-card-window">No report generated yet</div></div>`);
      }
    }

    const breadcrumbs: Breadcrumb[] = [
      { label: "All Reports", href: "/reports" },
      { label: dateLabel },
    ];
    const nav = renderNavBar(breadcrumbs);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(dateLabel)} — Akita Research</title>
  <link rel="stylesheet" href="/reports/styles.css" />
</head>
<body>
  ${nav}
  <div class="page">
    <div class="page-inner">
      <h1>${escapeHtml(dateLabel)}</h1>
      <p>No digest generated yet. Browse individual track reports:</p>
      <div class="plan-cards">${trackLinks.join("\n")}</div>
    </div>
    <footer class="page-footer">Generated by Akita Research Pipeline</footer>
  </div>
</body>
</html>`;
  } catch {}

  return null;
}

export async function renderTrackReport(planId: string, trackId: string): Promise<string | null> {
  const trackTitle = await readTrackTitle(trackId);

  // Get plan info for date label
  let dateLabel = planId;
  try {
    const planData = await readJson(resolve(plansDir, `${planId}.json`));
    dateLabel = formatDate(planData.created_at) || planId;
  } catch {}

  // Build prev/next from plan tracks
  let prevNext: PrevNext | undefined;
  try {
    const planData = await readJson(resolve(plansDir, `${planId}.json`));
    const entries: { track_id: string }[] = planData.entries || [];
    const idx = entries.findIndex((e) => e.track_id === trackId);
    if (idx > 0) {
      const prevTrack = entries[idx - 1];
      const prevTitle = await readTrackTitle(prevTrack.track_id);
      prevNext = { ...prevNext, prev: { label: prevTitle, href: `/reports/${planId}/${prevTrack.track_id}` } };
    }
    if (idx >= 0 && idx < entries.length - 1) {
      const nextTrack = entries[idx + 1];
      const nextTitle = await readTrackTitle(nextTrack.track_id);
      prevNext = { ...prevNext, next: { label: nextTitle, href: `/reports/${planId}/${nextTrack.track_id}` } };
    }
  } catch {}

  const breadcrumbs: Breadcrumb[] = [
    { label: "All Reports", href: "/reports" },
    { label: dateLabel, href: `/reports/${planId}` },
    { label: trackTitle },
  ];

  // Check if research log exists
  const logPath = resolve(tracksRoot, trackId, "reports", `${planId}.research.md`);
  let hasLog = false;
  try { await fs.access(logPath); hasLog = true; } catch {}
  const logLink = hasLog
    ? `<div style="font-family: var(--font-sans); font-size: var(--step--2); margin-bottom: 1.5rem;"><a href="/reports/${escapeHtml(planId)}/${escapeHtml(trackId)}/log" style="color: var(--ink-muted);">View research log</a></div>`
    : "";

  // Try HTML report first
  const htmlPath = resolve(tracksRoot, trackId, "reports", `${planId}.html`);
  try {
    let html = await fs.readFile(htmlPath, "utf8");
    html = injectNav(html, breadcrumbs, prevNext);
    if (logLink) {
      // Insert log link after the nav bar
      const pageInner = html.indexOf("page-inner");
      if (pageInner !== -1) {
        const afterTag = html.indexOf(">", pageInner);
        if (afterTag !== -1) {
          html = html.slice(0, afterTag + 1) + "\n" + logLink + html.slice(afterTag + 1);
        }
      }
    }
    return html;
  } catch {}

  // Fallback: render markdown report as HTML
  const mdPath = resolve(tracksRoot, trackId, "reports", `${planId}.md`);
  try {
    const md = await fs.readFile(mdPath, "utf8");
    const contentHtml = basicMarkdownToHtml(md);
    const nav = renderNavBar(breadcrumbs, prevNext);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(trackTitle)} — ${escapeHtml(dateLabel)} — Akita Research</title>
  <link rel="stylesheet" href="/reports/styles.css" />
</head>
<body>
  ${nav}
  <div class="page">
    <div class="page-inner prose">
      ${logLink}
      ${contentHtml}
    </div>
    <footer class="page-footer">Generated by Akita Research Pipeline</footer>
  </div>
</body>
</html>`;
  } catch {}

  return null;
}

export async function renderArticlePage(
  planId: string,
  trackId: string,
  articleIdx: number,
): Promise<string | null> {
  // Read issue JSON for article metadata
  const jsonPath = resolve(tracksRoot, trackId, "reports", `${planId}.json`);
  const mdPath = resolve(tracksRoot, trackId, "reports", `${planId}.md`);

  let issueMeta: any;
  let reportText: string;
  try {
    issueMeta = await readJson(jsonPath);
    reportText = await fs.readFile(mdPath, "utf8");
  } catch {
    return null;
  }

  const articles: any[] = issueMeta.articles || [];
  if (articleIdx < 0 || articleIdx >= articles.length) {
    return null;
  }

  const article = articles[articleIdx];
  const trackTitle = await readTrackTitle(trackId);

  // Extract article content from markdown
  const title = article.title || "Untitled";
  const articleContent = extractArticleSection(reportText, title);
  let contentHtml = basicMarkdownToHtml(articleContent);

  const typeLabel = (article.type || "deep-dive").replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
  const badgeClass = `badge-${escapeHtml(article.type || "deep-dive")}`;

  // Featured sources: hero image, floating card, source list
  const featured: any[] = article.featured_sources || [];
  const heroHtml = buildHeroImage(featured);
  const cardCandidates = featured.filter((s: any) => s.og_title);
  let cardHtml = "";
  if (cardCandidates.length >= 2) {
    cardHtml = buildSourceCard(cardCandidates[1], articleIdx % 2 === 0 ? "right" : "left");
  } else if (cardCandidates.length === 1 && !heroHtml) {
    cardHtml = buildSourceCard(cardCandidates[0], "right");
  }
  contentHtml = injectHeroAndCard(contentHtml, heroHtml, cardHtml);

  // Per-article source list from inline links
  const articleUrls = extractArticleUrls(contentHtml);
  const sourcesHtml = buildArticleSources(articleUrls);

  // Get plan info for date label
  let dateLabel = planId;
  try {
    const planData = await readJson(resolve(plansDir, `${planId}.json`));
    dateLabel = formatDate(planData.created_at) || planId;
  } catch {}

  // Prev/next articles
  const prevNext: PrevNext = {};
  if (articleIdx > 0) {
    prevNext.prev = {
      label: articles[articleIdx - 1].title || `Article ${articleIdx}`,
      href: `/reports/${planId}/${trackId}/${articleIdx - 1}`,
    };
  }
  if (articleIdx < articles.length - 1) {
    prevNext.next = {
      label: articles[articleIdx + 1].title || `Article ${articleIdx + 2}`,
      href: `/reports/${planId}/${trackId}/${articleIdx + 1}`,
    };
  }

  const breadcrumbs: Breadcrumb[] = [
    { label: "All Reports", href: "/reports" },
    { label: dateLabel, href: `/reports/${planId}` },
    { label: trackTitle, href: `/reports/${planId}/${trackId}` },
    { label: title },
  ];

  const nav = renderNavBar(breadcrumbs, Object.keys(prevNext).length ? prevNext : undefined);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — ${escapeHtml(trackTitle)} — Akita Research</title>
  <link rel="stylesheet" href="/reports/styles.css" />
</head>
<body>
  ${nav}
  <div class="page">
    <div class="page-inner">
      <div style="margin-bottom: 1.5rem;">
        <span class="article-type-badge ${badgeClass}">${escapeHtml(typeLabel)}</span>
      </div>
      <h1>${escapeHtml(title)}</h1>
      <p style="font-family: var(--font-sans); font-size: var(--step--1); color: var(--ink-muted); margin-bottom: 2rem;">
        ${escapeHtml(trackTitle)} &middot; ${escapeHtml(dateLabel)}
      </p>
      <div class="prose">${contentHtml}</div>
      ${sourcesHtml}
    </div>
    <footer class="page-footer">Generated by Akita Research Pipeline</footer>
  </div>
</body>
</html>`;
}

// ── Helpers ──

function extractArticleSection(reportText: string, title: string): string {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Try with type label line after heading
  const pattern1 = new RegExp(`## ${escaped}\\s*\\n\\*[^*]+\\*\\s*\\n([\\s\\S]*?)(?=\\n## |\\n---|$)`);
  const m1 = reportText.match(pattern1);
  if (m1) return m1[1].trim();
  // Simpler: just heading
  const pattern2 = new RegExp(`## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n---|$)`);
  const m2 = reportText.match(pattern2);
  if (m2) return m2[1].trim();
  return "";
}

function articleVisualsCss(): string {
  return `
.article-figure { margin: 1.5rem 0; max-width: 65ch; }
.article-figure img { width: 100%; height: auto; border-radius: 6px;
  border: 1px solid var(--paper-rule, #e0ddd6); }
.article-figure figcaption { font-family: var(--font-sans); font-size: var(--step--2);
  color: var(--ink-muted, #6b6b6b); margin-top: 0.4rem; }
.source-card { width: 240px; margin-bottom: 1rem; padding: 0.75rem;
  background: var(--paper-warm, #f5f3ef); border: 1px solid var(--paper-rule, #e0ddd6);
  border-radius: 8px; font-family: var(--font-sans); font-size: var(--step--2); }
.source-card a { display: flex; gap: 0.6rem; text-decoration: none; color: inherit; }
.source-card a:hover { text-decoration: none; }
.source-card-left { float: left; margin-right: 1.5rem; }
.source-card-right { float: right; margin-left: 1.5rem; }
.source-card-thumb { width: 64px; height: 64px; object-fit: cover;
  border-radius: 4px; flex-shrink: 0; }
.source-card-text { display: flex; flex-direction: column; gap: 0.15rem; overflow: hidden; }
.source-card-title { font-weight: 600; color: var(--ink, #1a1a1a); display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.source-card-desc { color: var(--ink-muted, #6b6b6b); display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.source-card-domain { color: var(--ink-faint, #999); font-size: 0.7rem; }
.article-sources { margin-top: 1.5rem; padding-top: 1rem;
  border-top: 1px solid var(--paper-rule, #e0ddd6); }
.article-sources h4 { font-family: var(--font-sans); font-size: var(--step--2);
  font-weight: 600; color: var(--ink-muted, #6b6b6b); text-transform: uppercase;
  letter-spacing: 0.06em; margin-bottom: 0.5rem; }
.article-sources ul { list-style: none; padding: 0; display: flex;
  flex-wrap: wrap; gap: 0.5rem 1.5rem; }
.article-sources li { font-family: var(--font-sans); font-size: var(--step--2); }
.article-sources a { color: var(--link, #2c5282); }
@media (max-width: 600px) {
  .source-card { float: none; width: 100%; margin: 1rem 0; }
  .source-card-left, .source-card-right { float: none; margin: 1rem 0; }
}
@media (prefers-color-scheme: dark) {
  .source-card { background: var(--paper-warm, #22211c); border-color: var(--paper-rule, #3a3830); }
}`;
}

function buildHeroImage(featured: any[]): string {
  for (const src of featured) {
    const img = src.og_image;
    if (!img || typeof img !== "string" || img.length < 10) continue;
    // Skip tiny logos/icons (common OG fallback images)
    if (/\b(\d{1,2}x\d{1,2}|logo|icon|favicon|badge)\b/i.test(img)) continue;
    const captionParts: string[] = [];
    if (src.og_title) captionParts.push(escapeHtml(src.og_title));
    if (src.og_site_name) captionParts.push(escapeHtml(src.og_site_name));
    const caption = captionParts.join(" — ");
    const captionHtml = caption ? `<figcaption>${caption}</figcaption>` : "";
    const proxiedImg = `/reports/img?url=${encodeURIComponent(img)}`;
    return (
      `<figure class="article-figure">` +
      `<img src="${escapeHtml(proxiedImg)}" alt="${escapeHtml(src.og_title || "")}" />` +
      `${captionHtml}</figure>`
    );
  }
  return "";
}

function buildSourceCard(src: any, side: string): string {
  const url = src.url || "";
  const title = escapeHtml(src.og_title || url);
  const desc = escapeHtml((src.og_description || "").slice(0, 120));
  const site = escapeHtml(src.og_site_name || "");
  const img = src.og_image;
  const proxiedThumb = img ? `/reports/img?url=${encodeURIComponent(img)}` : "";
  const thumb = img
    ? `<img class="source-card-thumb" src="${escapeHtml(proxiedThumb)}" alt="" loading="lazy" />`
    : "";
  return (
    `<aside class="source-card source-card-${side}">` +
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">` +
    `${thumb}` +
    `<div class="source-card-text">` +
    `<span class="source-card-title">${title}</span>` +
    `<span class="source-card-desc">${desc}</span>` +
    `<span class="source-card-domain">${site}</span>` +
    `</div></a></aside>`
  );
}

function injectHeroAndCard(contentHtml: string, heroHtml: string, cardHtml: string): string {
  if (heroHtml) {
    const firstP = contentHtml.indexOf("</p>");
    if (firstP !== -1) {
      const insertPos = firstP + "</p>".length;
      contentHtml = contentHtml.slice(0, insertPos) + "\n" + heroHtml + contentHtml.slice(insertPos);
    }
  }
  if (cardHtml) {
    const pPositions: number[] = [];
    const pRegex = /<p>/g;
    let match: RegExpExecArray | null;
    while ((match = pRegex.exec(contentHtml)) !== null) {
      pPositions.push(match.index);
    }
    if (pPositions.length >= 3) {
      const midIdx = Math.floor(pPositions.length / 2);
      const midPos = pPositions[midIdx];
      contentHtml = contentHtml.slice(0, midPos) + cardHtml + "\n" + contentHtml.slice(midPos);
    }
  }
  return contentHtml;
}

function extractArticleUrls(html: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  const regex = /<a\s[^>]*href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    const url = m[1];
    if (url.startsWith("http") && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function buildArticleSources(urls: string[]): string {
  if (!urls.length) return "";
  const items = urls
    .map((url) => {
      const domain = url.split("//")[1]?.split("/")[0] || url;
      return `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(domain)}</a></li>`;
    })
    .join("");
  return (
    `<div class="article-sources">` +
    `<h4>Sources</h4>` +
    `<ul>${items}</ul>` +
    `</div>`
  );
}

export async function renderResearchLog(planId: string, trackId: string): Promise<string | null> {
  const logPath = resolve(tracksRoot, trackId, "reports", `${planId}.research.md`);
  let md: string;
  try {
    md = await fs.readFile(logPath, "utf8");
  } catch {
    return null;
  }

  const trackTitle = await readTrackTitle(trackId);
  let dateLabel = planId;
  try {
    const planData = await readJson(resolve(plansDir, `${planId}.json`));
    dateLabel = formatDate(planData.created_at) || planId;
  } catch {}

  const breadcrumbs: Breadcrumb[] = [
    { label: "All Reports", href: "/reports" },
    { label: dateLabel, href: `/reports/${planId}` },
    { label: trackTitle, href: `/reports/${planId}/${trackId}` },
    { label: "Research Log" },
  ];

  const contentHtml = researchLogToHtml(md);
  const nav = renderNavBar(breadcrumbs);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Research Log — ${escapeHtml(trackTitle)} — ${escapeHtml(dateLabel)}</title>
  <link rel="stylesheet" href="/reports/styles.css" />
  <style>${researchLogCss()}</style>
</head>
<body>
  ${nav}
  <div class="page">
    <div class="page-inner">
      <h1>Research Log</h1>
      <p style="font-family: var(--font-sans); font-size: var(--step--1); color: var(--ink-muted); margin-bottom: 2rem;">
        ${escapeHtml(trackTitle)} &middot; ${escapeHtml(dateLabel)}
      </p>
      <div class="research-log">${contentHtml}</div>
    </div>
    <footer class="page-footer">Generated by Akita Research Pipeline</footer>
  </div>
</body>
</html>`;
}

function researchLogCss(): string {
  return `
.research-log { font-family: var(--font-sans); font-size: var(--step--1); }
.research-log h2 { font-size: var(--step-1); margin-top: 2rem; margin-bottom: 0.75rem;
  padding-bottom: 0.4rem; border-bottom: 1px solid var(--paper-rule); }
.research-log ul { list-style: none; padding: 0; }
.research-log li { padding: 0.4rem 0; border-bottom: 1px solid var(--paper-rule); }
.research-log li:last-child { border-bottom: none; }
.research-log li strong { color: var(--accent); }
.rlog-detail { padding-left: 1.25rem; color: var(--ink-muted); font-size: var(--step--2); }
.rlog-score { font-family: var(--font-mono); font-size: var(--step--2); color: var(--ink-faint); }
.rlog-url { word-break: break-all; }
.rlog-section-count { font-family: var(--font-sans); font-size: var(--step--2);
  color: var(--ink-faint); font-weight: 400; margin-left: 0.5rem; }`;
}

function researchLogToHtml(md: string): string {
  const formatInline = (text: string): string => {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/(https?:\/\/\S+)/g, (url) => {
        if (url.startsWith('<a')) return url; // already linked
        return `<a href="${url}" class="rlog-url" target="_blank" rel="noopener">${url}</a>`;
      })
      .replace(/\(score=([\d.]+)\)/g, '<span class="rlog-score">(score=$1)</span>');
  };

  const lines = md.split("\n");
  const output: string[] = [];
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) { output.push("</ul>"); inList = false; }
      continue;
    }

    // Section heading
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      if (inList) { output.push("</ul>"); inList = false; }
      const level = heading[1].length;
      output.push(`<h${level}>${formatInline(heading[2])}</h${level}>`);
      continue;
    }

    // List item
    if (trimmed.startsWith("- ")) {
      if (!inList) { output.push("<ul>"); inList = true; }
      output.push(`<li>${formatInline(trimmed.slice(2))}</li>`);
      continue;
    }

    // Indented detail (continuation of previous item)
    if (trimmed.startsWith("  ") && inList) {
      output.push(`<div class="rlog-detail">${formatInline(trimmed)}</div>`);
      continue;
    }

    // Plain text
    if (inList) { output.push("</ul>"); inList = false; }
    output.push(`<p>${formatInline(trimmed)}</p>`);
  }
  if (inList) output.push("</ul>");

  return output.join("\n");
}

function basicMarkdownToHtml(md: string): string {
  const formatInline = (text: string): string => {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  };

  // Split into blocks separated by blank lines
  const blocks = md.split(/\n{2,}/);
  const output: string[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Heading
    const heading = trimmed.match(/^(#{1,6})\s+([\s\S]*)$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${formatInline(heading[2].replace(/\n/g, " "))}</h${level}>`);
      continue;
    }

    // HR
    if (/^---+$/.test(trimmed)) {
      output.push("<hr />");
      continue;
    }

    // List block (all lines start with - or *)
    const listLines = trimmed.split("\n");
    if (listLines.every((l) => /^\s*[-*]\s+/.test(l))) {
      output.push("<ul>");
      for (const li of listLines) {
        output.push(`<li>${formatInline(li.replace(/^\s*[-*]\s+/, ""))}</li>`);
      }
      output.push("</ul>");
      continue;
    }

    // Paragraph — join lines with spaces, then format
    const paraText = trimmed.replace(/\n/g, " ");
    output.push(`<p>${formatInline(paraText)}</p>`);
  }

  return output.join("\n");
}
