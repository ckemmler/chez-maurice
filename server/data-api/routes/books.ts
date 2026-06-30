import { Hono } from "hono";
import { getBookRecommendations, getBookCounts, getDistinctTrackIds } from "../services/recommendations";
import { getBriefingTopicNames } from "../services/dossiers";

const books = new Hono();

books.get("/", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const trackId = c.req.query("track") || "";
  const view = c.req.query("view") || "counts"; // "counts" or "recent"
  const month = c.req.query("month") || "";
  const sort = c.req.query("sort") === "asc" ? "asc" as const : "desc" as const;

  const trackIds = getDistinctTrackIds(memberId, "book");
  const topicNames = getBriefingTopicNames(memberId);

  let content: string;
  if (view === "recent" || trackId || month) {
    const recs = getBookRecommendations(memberId, {
      trackId: trackId || undefined,
      month: month || undefined,
      sortOrder: sort,
      limit: 200,
    });
    content = recs.map(rec => {
      const inLibrary = rec.calibre_book_id ? `<span class="book-badge library">In Library</span>` : "";
      const cover = rec.cover_url
        ? `<img class="book-cover" src="${escapeHtml(rec.cover_url)}" alt="" loading="lazy" />`
        : `<div class="book-cover book-cover-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg></div>`;
      const details = [rec.pub_year, rec.page_count ? `${rec.page_count} pp.` : null, rec.publisher].filter(Boolean).join(" · ");
      return `<div class="book-card">
        ${cover}
        <div class="book-card-body">
          <div class="book-card-title">${escapeHtml(rec.title)}</div>
          <div class="book-card-author">${escapeHtml(rec.author || "Unknown author")}</div>
          ${details ? `<div class="book-card-details">${escapeHtml(details)}</div>` : ""}
          <div class="book-card-summary">${escapeHtml(rec.summary || "")}</div>
          <div class="book-card-meta">
            <span class="track-pill has-report">${escapeHtml(topicNames[rec.track_id] || rec.track_id)}</span>
            ${inLibrary}
            <span class="rec-card-date">${escapeHtml(rec.recommended_at?.slice(0, 10) || "")}</span>
          </div>
        </div>
      </div>`;
    }).join("\n");
  } else {
    const counts = getBookCounts(memberId);
    content = counts.map(item => {
      const trackBadges = item.tracks.split(",").map(t =>
        `<span class="track-pill">${escapeHtml(topicNames[t] || t)}</span>`
      ).join(" ");
      const inLibrary = item.calibre_book_id ? `<span class="book-badge library">In Library</span>` : "";
      const countBadge = item.total_count > 1 ? `<span class="book-badge count">${item.total_count}x recommended</span>` : "";
      const cover = item.cover_url
        ? `<img class="book-cover" src="${escapeHtml(item.cover_url)}" alt="" loading="lazy" />`
        : `<div class="book-cover book-cover-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg></div>`;
      const details = [item.pub_year, item.page_count ? `${item.page_count} pp.` : null, item.publisher].filter(Boolean).join(" · ");
      return `<div class="book-card">
        ${cover}
        <div class="book-card-body">
          <div class="book-card-title">${escapeHtml(item.title)}</div>
          <div class="book-card-author">${escapeHtml(item.author || "Unknown author")}</div>
          ${details ? `<div class="book-card-details">${escapeHtml(details)}</div>` : ""}
          <div class="book-card-meta">
            ${countBadge} ${inLibrary} ${trackBadges}
          </div>
        </div>
      </div>`;
    }).join("\n");
  }

  const trackOptions = trackIds.map(t =>
    `<option value="${escapeHtml(t)}"${trackId === t ? " selected" : ""}>${escapeHtml(topicNames[t] || t)}</option>`
  ).join("");

  const filterBar = `<form method="get" class="filter-bar">
    <label>
      <span class="filter-label">Topic</span>
      <select name="track">
        <option value="">All topics</option>
        ${trackOptions}
      </select>
    </label>
    <label>
      <span class="filter-label">Month</span>
      ${monthPickerHtml(month)}
    </label>
    <label>
      <span class="filter-label">View</span>
      <select name="view">
        <option value="counts"${view === "counts" ? " selected" : ""}>By count</option>
        <option value="recent"${view === "recent" ? " selected" : ""}>Recent</option>
      </select>
    </label>
    <label>
      <span class="filter-label">Sort</span>
      <select name="sort">
        <option value="desc"${sort === "desc" ? " selected" : ""}>Newest first</option>
        <option value="asc"${sort === "asc" ? " selected" : ""}>Oldest first</option>
      </select>
    </label>
    <button type="submit">Filter</button>
  </form>`;

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Book Recommendations — Akita Research</title>
  <link rel="stylesheet" href="/reports/styles.css" />
  <style>${booksPageCss()}</style>
</head>
<body>
  <nav class="report-nav"><div class="report-nav-inner">
    <div class="report-nav-crumbs">
      <a href="/dossiers">Dossiers</a> <span class="sep">/</span>
      <span class="current">Books</span>
    </div>
    <div class="report-nav-links">
      <a href="/articles">Articles</a>
      <a href="/dossiers">Dossiers</a>
    </div>
  </div></nav>
  <div class="page">
    <div class="page-inner">
      <h1>Book Recommendations</h1>
      ${filterBar}
      <div class="book-cards">${content}</div>
    </div>
    <footer class="page-footer">Generated by Akita Research Pipeline</footer>
  </div>
  ${monthPickerScript()}
</body>
</html>`);
});

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function monthPickerHtml(currentMonth: string): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [selYear, selMon] = currentMonth ? currentMonth.split("-") : ["", ""];
  const monthOpts = months.map((m, i) => {
    const val = String(i + 1).padStart(2, "0");
    return `<option value="${val}"${val === selMon ? " selected" : ""}>${m}</option>`;
  }).join("");
  const now = new Date().getFullYear();
  const yearOpts = Array.from({length: now - 2023}, (_, i) => now - i)
    .map(y => `<option value="${y}"${String(y) === selYear ? " selected" : ""}>${y}</option>`)
    .join("");
  return `<span class="month-picker">
    <select class="mp-month"><option value="">Any month</option>${monthOpts}</select>
    <select class="mp-year"><option value="">Any year</option>${yearOpts}</select>
    <input type="hidden" name="month" value="${escapeHtml(currentMonth)}" />
  </span>`;
}

function monthPickerScript(): string {
  return `<script>
document.querySelectorAll('.month-picker').forEach(picker => {
  const ms = picker.querySelector('.mp-month');
  const ys = picker.querySelector('.mp-year');
  const hidden = picker.querySelector('input[type="hidden"]');
  function sync() {
    const m = ms.value, y = ys.value;
    hidden.value = (m && y) ? y + '-' + m : '';
  }
  ms.addEventListener('change', sync);
  ys.addEventListener('change', sync);
});
</script>`;
}

function booksPageCss(): string {
  return `
.filter-bar { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; margin-top: 1.5rem; padding: 1rem 1.25rem;
  background: var(--paper-warm); border: 1px solid var(--paper-rule); border-radius: 12px; }
.filter-bar label { display: flex; flex-direction: column; gap: 0.25rem; }
.filter-label { font-family: var(--font-sans); font-size: var(--step--2); font-weight: 600; color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.filter-bar select, .filter-bar input[type="month"] { font-family: var(--font-sans); font-size: var(--step--1); padding: 0.35em 0.6em;
  border: 1px solid var(--paper-rule); border-radius: 6px; background: var(--paper); color: var(--ink); }
.month-picker { display: flex; gap: 0.25rem; }
.month-picker select { font-family: var(--font-sans); font-size: var(--step--1); padding: 0.35em 0.6em;
  border: 1px solid var(--paper-rule); border-radius: 6px; background: var(--paper); color: var(--ink); }
.filter-bar button { font-family: var(--font-sans); font-size: var(--step--1); font-weight: 600; padding: 0.4em 1em;
  border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
.filter-bar button:hover { opacity: 0.9; }
.book-cards { display: flex; flex-direction: column; gap: 1rem; margin-top: 2rem; }
.book-card { background: var(--paper-warm); border: 1px solid var(--paper-rule);
  border-radius: 12px; padding: 1.25rem 1.5rem; display: flex; gap: 1.25rem; align-items: flex-start; }
.book-cover { width: 80px; min-width: 80px; height: 120px; border-radius: 6px; object-fit: cover; background: var(--paper-rule); }
.book-cover-placeholder { display: flex; align-items: center; justify-content: center; color: var(--ink-muted); }
.book-cover-placeholder svg { width: 32px; height: 32px; }
.book-card-body { flex: 1; min-width: 0; }
.book-card-title { font-family: var(--font-sans); font-size: var(--step-1); font-weight: 700; color: var(--ink); margin-bottom: 0.25rem; }
.book-card-author { font-family: var(--font-sans); font-size: var(--step--1); color: var(--ink-muted); margin-bottom: 0.25rem; }
.book-card-details { font-family: var(--font-sans); font-size: var(--step--2); color: var(--ink-muted); margin-bottom: 0.5rem; }
.book-card-summary { font-size: var(--step--1); color: var(--ink-light); margin-bottom: 0.75rem; }
.book-card-meta { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
.book-badge { font-family: var(--font-sans); font-size: var(--step--2); font-weight: 600;
  padding: 0.15em 0.6em; border-radius: 100px; }
.book-badge.library { background: #22763820; color: #227638; border: 1px solid #22763840; }
.book-badge.count { background: var(--accent)15; color: var(--accent); border: 1px solid var(--accent)30; }
@media (prefers-color-scheme: dark) {
  .book-badge.library { background: #4abb7030; color: #4abb70; }
}
@media (max-width: 600px) { .filter-bar { flex-direction: column; } }`;
}

export default books;
