// Server-rendered HTML helpers for the Maurice web admin — editorial "Maurice"
// style: warm paper, Fraunces headings, Inter UI, JetBrains Mono meta.

import { t } from "../services/i18n";

export function escape(str: string): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function h(tag: string, attrs: Record<string, string>, ...children: string[]): string {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escape(v)}"`)
    .join("");
  return `<${tag}${attrStr}>${children.join("")}</${tag}>`;
}

export function layout(title: string, body: string, showNav = false, adminName = "", lang: string = "en"): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escape(title)} — Chez Maurice</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>${CSS}</style>
</head>
<body>
  ${showNav ? nav(adminName, lang) : ""}
  <main>${body}</main>
</body>
</html>`;
}

function nav(adminName: string, lang: string = "en"): string {
  return `
<div class="topnav">
  <div class="topnav-inner">
    <a href="/admin/dashboard" class="brand">
      <span class="brand-badge" aria-hidden="true"></span>
      <span class="brand-word">Chez Maurice</span>
    </a>
    <span class="nav-sep"></span>
    <span class="nav-cog">⚙ ${escape(t(lang, "nav.settings"))}</span>
    <div style="flex:1"></div>
    <select class="nav-lang" onchange="location.search='?lang='+this.value" aria-label="Language" title="Language">
      ${["en","fr","it","de","es","pt","nl"]
        .map((c) => `<option value="${c}" ${c === lang ? "selected" : ""}>${c.toUpperCase()}</option>`).join("")}
    </select>
    <a href="/admin/tokens" class="nav-link">${escape(t(lang, "nav.tokens"))}</a>
    <a href="/admin/logout" class="nav-link">${escape(t(lang, "nav.logout"))}</a>
    ${adminName ? `<span class="nav-admin">${escape(t(lang, "nav.admin_label", adminName.toLowerCase()))}</span>` : ""}
  </div>
</div>`;
}

const CSS = `
  /* Young Serif — the "Chez Maurice" logotype face, shared with the iOS app. */
  @font-face {
    font-family: "Young Serif";
    src: url("/admin/brand/young-serif.ttf") format("truetype");
    font-weight: 400; font-style: normal; font-display: swap;
  }
  :root {
    --bg: #ece3d4;
    --surface: #fbf7f0;
    --surface-alt: #f0e8da;
    --inset: #f0e8da;
    --ink: #262320;
    --ink-soft: #5f574e;
    --ink-mute: #948b7e;
    --ink-hint: #b3a899;
    --rule: rgba(38,35,32,0.10);
    --rule-hard: rgba(38,35,32,0.17);
    --accent: #9c4a2f;
    --accent-soft: #9c4a2f18;
    --ok: #3d6b4f;
    --ok-soft: #3d6b4f1e;
    --cloud: #2c5aa0;
    --cloud-soft: #2c5aa01c;
    --caution: #b97a1e;
    --caution-soft: #b97a1e1f;
    --serif: "Fraunces", Georgia, serif;
    --display: "Young Serif", "Fraunces", Georgia, serif;
    --sans: "Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    --mono: "JetBrains Mono", ui-monospace, "SF Mono", monospace;
    --radius: 16px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--sans);
    background: var(--bg);
    color: var(--ink);
    line-height: 1.5;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }

  /* ── top nav ── */
  .topnav {
    position: sticky; top: 0; z-index: 50;
    background: rgba(236,227,212,0.86);
    backdrop-filter: blur(10px);
    border-bottom: 0.5px solid var(--rule);
  }
  .topnav-inner {
    max-width: 1000px; margin: 0 auto; padding: 0 24px;
    height: 58px; display: flex; align-items: center; gap: 12px;
  }
  .brand { display: inline-flex; align-items: center; gap: 9px; color: var(--ink); text-decoration: none; }
  /* The melon-hat logomark, tinted to ink via a mask so it reads on the paper nav. */
  .brand-badge {
    width: 30px; height: 23px; background: var(--ink);
    -webkit-mask: url("/admin/brand/hat.png") center/contain no-repeat;
    mask: url("/admin/brand/hat.png") center/contain no-repeat;
  }
  .brand-word { font-family: var(--display); font-weight: 400; font-size: 20px; letter-spacing: 0; }
  .nav-sep { width: 0.5px; height: 22px; background: var(--rule-hard); margin: 0 4px; }
  .nav-cog { color: var(--ink-soft); font-size: 14px; font-weight: 500; }
  .nav-link { color: var(--ink-soft); text-decoration: none; font-size: 13px; margin-left: 16px; }
  .nav-link:hover { color: var(--ink); }
  .nav-lang { width: auto; font-family: var(--mono); font-size: 12px; color: var(--ink-soft); background: transparent;
    border: 0.5px solid var(--rule); border-radius: 6px; padding: 3px 6px; margin-left: 16px; cursor: pointer; }
  .nav-admin { font-family: var(--mono); font-size: 11px; color: var(--ink-mute); margin-left: 16px; }

  main { max-width: 1000px; margin: 0 auto; padding: 40px 24px 90px; }
  .stack { display: flex; flex-direction: column; gap: 46px; }

  .page-title { font-family: var(--serif); font-size: 40px; letter-spacing: -0.02em; font-weight: 400; line-height: 1; }
  .page-sub { margin-top: 10px; font-size: 15px; color: var(--ink-soft); max-width: 560px; line-height: 1.5; }

  /* ── section heads ── */
  .kicker { font-family: var(--mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
  .sec-title { font-family: var(--serif); font-size: 26px; letter-spacing: -0.01em; font-weight: 400; margin-top: 4px; line-height: 1.1; }
  .sec-desc { margin-top: 7px; font-size: 13.5px; color: var(--ink-soft); max-width: 620px; line-height: 1.5; }
  .sec-headrow { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; }

  /* ── cards ── */
  .card {
    background: var(--surface);
    border: 0.5px solid var(--rule-hard);
    border-radius: var(--radius);
    box-shadow: 0 1px 2px rgba(38,35,32,0.04), 0 8px 24px rgba(38,35,32,0.05);
  }
  .card.pad { padding: 22px; }
  .card.flush { overflow: hidden; }
  .card + .card { margin-top: 18px; }

  /* ── buttons ── */
  .btn {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 9px 16px; border-radius: 999px; border: 0.5px solid transparent;
    font-family: var(--sans); font-size: 13.5px; font-weight: 500; cursor: pointer;
    text-decoration: none; background: var(--ink); color: #f5efe6; line-height: 1;
  }
  .btn:hover { opacity: 0.92; }
  .btn.sm { padding: 6px 12px; font-size: 12.5px; }
  .btn.primary { background: var(--accent); color: #fff; }
  .btn.accent { background: var(--ok); color: #fff; }
  .btn.default { background: var(--surface); color: var(--ink); border-color: var(--rule-hard); }
  .btn.default:hover { background: var(--surface-alt); }
  .btn.ghost { background: transparent; color: var(--ink-soft); border-color: var(--rule-hard); }
  .btn.ghost:hover { background: var(--surface-alt); color: var(--ink); }
  .btn.danger { background: transparent; color: var(--accent); border: 0.5px solid var(--accent); }
  .btn.danger:hover { background: var(--accent-soft); }
  .btn[disabled] { opacity: 0.45; cursor: not-allowed; }
  .inline { display: inline; }

  /* ── fields ── */
  .field { display: block; }
  .field + .field { margin-top: 16px; }
  .label { display: block; font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-mute); margin-bottom: 6px; }
  .hint { display: block; font-size: 12px; color: var(--ink-mute); margin-top: 5px; }
  input[type=text], input[type=password], input[type=number], textarea, select {
    width: 100%; padding: 9px 12px; border: 0.5px solid var(--rule-hard); border-radius: 10px;
    font-size: 14px; font-family: var(--sans); background: var(--surface-alt); color: var(--ink);
  }
  input.mono { font-family: var(--mono); font-size: 13px; }
  textarea { resize: vertical; min-height: 90px; line-height: 1.5; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: var(--ink-soft); box-shadow: 0 0 0 3px rgba(38,35,32,0.07); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .grid3 { display: grid; grid-template-columns: 1.4fr 1fr 0.7fr; gap: 12px; align-items: end; }
  /* In a grid, the cell gap handles spacing — the stacked-field margin would
     push the 2nd column down and break row alignment. */
  .grid2 > .field + .field, .grid3 > .field + .field { margin-top: 0; }
  .grid-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }

  /* ── dialog (edit/add) — three even zones at 20px ── */
  .dialog { overflow: hidden; }
  .dialog-head { display: flex; align-items: center; gap: 13px; padding: 17px 20px; border-bottom: 0.5px solid var(--rule); }
  .dialog-head .eyebrow { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-mute); }
  .dialog-head .ttl { font-family: var(--serif); font-size: 21px; letter-spacing: -0.01em; line-height: 1.1; }
  .dialog-body { padding: 20px; display: flex; flex-direction: column; gap: 18px; }
  .dialog-body .field + .field { margin-top: 0; } /* gap handles rhythm */
  .dialog-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 0.5px solid var(--rule); background: var(--surface-alt); }
  .access-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
  .access-head .ttl2 { font-size: 12.5px; font-weight: 500; }
  .access-head .cnt { font-family: var(--mono); font-size: 10px; color: var(--ink-mute); }
  .access-head .cnt.admin { color: var(--accent); }

  /* ── member rows ── */
  .member { display: flex; align-items: center; gap: 13px; padding: 14px 18px; flex-wrap: wrap; }
  .member + .member { border-top: 0.5px solid var(--rule); }
  .avatar {
    width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0; object-fit: cover;
    display: inline-flex; align-items: center; justify-content: center; color: #fff; font-weight: 600; font-size: 15px;
    background-size: cover; background-position: center;
  }
  .who { flex: 1; min-width: 140px; }
  .who .nm { font-size: 14.5px; font-weight: 600; }
  .who .hd { font-family: var(--mono); font-size: 11.5px; color: var(--ink-mute); }
  .tag { font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; }
  .tag.admin { background: var(--accent-soft); color: var(--accent); }
  .tag.standard { background: var(--surface-alt); color: var(--ink-soft); }
  .pin { font-family: var(--mono); font-size: 11px; color: var(--ink-mute); display: inline-flex; align-items: center; gap: 5px; }
  .member-actions { display: flex; gap: 8px; align-items: center; }

  /* ── model rows ── */
  .model-head { display: flex; align-items: center; gap: 14px; padding: 15px 18px; }
  .model-head.ok { background: var(--ok-soft); }
  .model-head.cloud { background: var(--cloud-soft); }
  .model-head.caution { background: var(--caution-soft); }
  .head-icon { width: 38px; height: 38px; border-radius: 10px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: var(--surface); box-shadow: inset 0 0 0 0.5px var(--rule-hard); font-size: 18px; }
  .head-logo { width: 22px; height: 22px; object-fit: contain; display: block; }
  .head-main { flex: 1; min-width: 0; }
  .head-title { font-size: 15px; font-weight: 600; }
  .head-meta { font-family: var(--mono); font-size: 11px; color: var(--ink-soft); margin-top: 3px; }
  .status-dot { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 10.5px; margin-left: 8px; }
  .dotmark { width: 7px; height: 7px; border-radius: 4px; display: inline-block; }
  .ram-bar { display: inline-flex; align-items: center; gap: 7px; }
  .ram-track { width: 56px; height: 4px; border-radius: 2px; background: var(--inset); box-shadow: inset 0 0 0 0.5px var(--rule); overflow: hidden; }
  .ram-fill { display: block; height: 100%; background: var(--ok); }
  .ram-num { font-family: var(--mono); font-size: 10.5px; color: var(--ink-soft); }
  .ram-lab { font-family: var(--mono); font-size: 9.5px; color: var(--ink-mute); letter-spacing: 0.04em; text-transform: uppercase; }

  .model-row { display: flex; align-items: center; gap: 13px; padding: 12px 16px; border-top: 0.5px solid var(--rule); }
  .model-icon { width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 15px; }
  .model-icon.local { color: var(--ok); background: var(--ok-soft); }
  .model-icon.cloud { color: var(--cloud); background: var(--cloud-soft); }
  .model-main { flex: 1; min-width: 0; }
  .model-name { font-size: 14px; font-weight: 600; }
  .model-id { font-family: var(--mono); font-size: 11px; color: var(--ink-mute); margin-left: 9px; }
  .model-desc { font-size: 12px; color: var(--ink-soft); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .model-meta { display: flex; align-items: center; gap: 16px; flex-shrink: 0; }
  .mono-num { font-family: var(--mono); font-size: 10.5px; color: var(--ink-mute); text-align: right; }
  .trash { background: none; border: none; color: var(--ink-mute); cursor: pointer; padding: 4px; font-size: 14px; line-height: 1; }
  .trash:hover { color: var(--accent); }
  .addbar { padding: 12px 16px; border-top: 0.5px solid var(--rule); }
  .addform { padding: 16px; border-top: 0.5px solid var(--rule); background: var(--surface-alt); }

  /* ── access matrix ── */
  .matrix-scroll { overflow-x: auto; }
  .mx-row { display: flex; align-items: stretch; }
  .mx-row + .mx-row { border-top: 0.5px solid var(--rule); }
  .mx-grouphead, .mx-modelhead { display: flex; }
  .mx-grouphead { border-bottom: 0.5px solid var(--rule); }
  .mx-modelhead { border-bottom: 0.5px solid var(--rule-hard); background: var(--surface-alt); }
  .mx-namecol { width: 208px; flex-shrink: 0; }
  .mx-col { width: 88px; flex-shrink: 0; border-left: 0.5px solid var(--rule); text-align: center; }
  .mx-group-lab { padding: 10px 0 8px; font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; }
  .mx-group-lab.cloud { color: var(--cloud); }
  .mx-group-lab.local { color: var(--ok); }
  .mx-modelcell { padding: 9px 4px 8px; }
  .mx-short { font-size: 11.5px; font-weight: 600; line-height: 1.2; }
  .mx-sub { font-family: var(--mono); font-size: 9px; color: var(--ink-mute); margin-top: 3px; }
  .mx-member { display: flex; align-items: center; gap: 11px; padding: 0 14px; }
  .mx-mem-nm { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mx-mem-sub { font-family: var(--mono); font-size: 9.5px; color: var(--ink-mute); }
  .mx-mem-sub.admin { color: var(--accent); }
  .mx-head-member { display: flex; align-items: flex-end; padding: 0 0 9px 18px; font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-mute); }
  .star { color: var(--caution); }
  .matrix-actions { padding: 14px 18px; border-top: 0.5px solid var(--rule); display: flex; justify-content: flex-end; }

  /* cell as styled checkbox */
  .cellbox { display: flex; align-items: center; justify-content: center; height: 44px; cursor: pointer; position: relative; }
  .cellbox input { position: absolute; opacity: 0; pointer-events: none; }
  .dot { width: 26px; height: 26px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 14px; box-shadow: inset 0 0 0 1px var(--rule-hard); background: transparent; }
  .dot .pip { width: 5px; height: 5px; border-radius: 3px; background: var(--rule-hard); }
  .dot .chk { display: none; }
  .cellbox.cloud input:checked + .dot { background: var(--cloud); box-shadow: none; }
  .cellbox.local input:checked + .dot { background: var(--ok); box-shadow: none; }
  .cellbox input:checked + .dot .pip { display: none; }
  .cellbox input:checked + .dot .chk { display: block; }
  .cellbox.locked { cursor: default; }
  .cellbox.locked .dot { opacity: 0.55; }

  .legend { font-family: var(--mono); font-size: 10.5px; color: var(--ink-mute); margin-top: 12px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .sw { width: 12px; height: 12px; border-radius: 4px; display: inline-block; }

  /* ── access chips (edit page) ── */
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 7px; padding: 6px 11px 6px 9px; border-radius: 999px; cursor: pointer; box-shadow: inset 0 0 0 0.5px var(--rule-hard); background: transparent; }
  .chip input { position: absolute; opacity: 0; pointer-events: none; }
  .chip .cdot { width: 15px; height: 15px; border-radius: 5px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 10px; box-shadow: inset 0 0 0 1px var(--rule-hard); }
  .chip .cdot .chk { display: none; }
  .chip .clab { font-size: 12.5px; }
  .chip input:checked + .cdot .chk { display: block; }
  .chip.cloud:has(input:checked) .cdot { background: var(--cloud); box-shadow: none; }
  .chip.local:has(input:checked) .cdot { background: var(--ok); box-shadow: none; }
  .chip input:checked ~ .clab { font-weight: 500; }
  .chip.cloud:has(input:checked) { background: var(--cloud-soft); box-shadow: inset 0 0 0 0.5px var(--cloud)55; }
  .chip.local:has(input:checked) { background: var(--ok-soft); box-shadow: inset 0 0 0 0.5px var(--ok)55; }
  .chips-lab { font-family: var(--mono); font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; margin: 0 0 7px; }
  .chips-lab.cloud { color: var(--cloud); }
  .chips-lab.local { color: var(--ok); }

  /* color swatches */
  .swatches { display: flex; gap: 9px; flex-wrap: wrap; }
  .swatch input { display: none; }
  .swatch span { display: block; width: 28px; height: 28px; border-radius: 14px; cursor: pointer; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.18); }
  .swatch input:checked + span { box-shadow: 0 0 0 2px var(--surface), 0 0 0 3.5px currentColor; }

  /* ── flashes / toast ── */
  .flash { display: inline-flex; align-items: center; gap: 8px; background: var(--ok-soft); color: var(--ok); border: 0.5px solid var(--ok); border-radius: 999px; padding: 8px 16px; font-size: 13px; font-weight: 500; margin-bottom: 24px; }
  .error { color: var(--accent); font-size: 14px; padding: 9px 13px; background: var(--accent-soft); border-radius: 10px; margin-bottom: 16px; }
  .muted { color: var(--ink-mute); font-size: 13px; }
  .empty { padding: 20px; color: var(--ink-mute); font-size: 13.5px; }
  pre.token { background: var(--surface-alt); padding: 10px; border-radius: 10px; word-break: break-all; font-family: var(--mono); font-size: 13px; margin-top: 8px; }

  /* setup/login */
  .setup { max-width: 420px; margin: 70px auto; }
  .setup .sec-title { margin-bottom: 6px; }

  hr { border: none; border-top: 0.5px solid var(--rule); margin: 0; }

  @media (max-width: 720px) {
    .grid2, .grid3 { grid-template-columns: 1fr; }
    .page-title { font-size: 32px; }
  }
`;
