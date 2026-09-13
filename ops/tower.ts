#!/usr/bin/env bun
/**
 * The control tower, in a terminal: every instance of ops/fleet.yaml, probed
 * every 30 s, with an error sparkline per instance and one key to deploy.
 *
 *   ops/tower.ts              all instances
 *   ops/tower.ts --every 10   poll interval in seconds
 *   ops/tower.ts --once       one frame to stdout, no keys (a pipe, a test)
 *
 *   ↑/↓ or j/k  select      r  probe now       d  deploy the selected one
 *   l           toggle log  q  quit            (a deploy asks y/n first)
 *
 * Deploying runs the instance's `deploy:` command from fleet.yaml, from the
 * repo root, one at a time, its output in the log pane. No daemon, no port,
 * no tunnel: this runs where the operator is (a terminal on the Mac mini, or
 * an ssh session into it), which is the whole of its access control. Tokens
 * are read from ~/.maurice/ops/fleet-tokens, never shown.
 */
import { REPO_DIR, age, isBad, probeAll, readFleet, table, type Instance, type Row } from "./fleet";

const argv = process.argv.slice(2);
const everyIdx = argv.indexOf("--every");
const EVERY_S = everyIdx >= 0 ? Math.max(5, Number(argv[everyIdx + 1]) || 30) : 30;
const HISTORY = 40;

// ── State ───────────────────────────────────────────────────────

let fleet: Instance[] = readFleet();
let rows: Row[] = [];
const history = new Map<string, (number | null)[]>(); // errors_1h per poll, null = unreachable
let selected = 0;
let showLog = true;
let confirming: Instance | null = null;
let deploying: { name: string; startedAt: number } | null = null;
let lastPoll = 0;
let nextPoll = Date.now();
let log: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function say(line: string) {
  const stamp = new Date().toTimeString().slice(0, 8);
  log.push(`${stamp} ${line}`);
  if (log.length > 500) log = log.slice(-500);
}

// ── Probing ─────────────────────────────────────────────────────

async function poll() {
  if (timer) clearTimeout(timer);
  timer = null;
  try {
    fleet = readFleet();
    rows = await probeAll(fleet);
    for (const r of rows) {
      const h = history.get(r.name) ?? [];
      h.push(r.reach === "down" ? null : r.errors_1h ?? 0);
      if (h.length > HISTORY) h.splice(0, h.length - HISTORY);
      history.set(r.name, h);
    }
    lastPoll = Date.now();
  } catch (err) {
    say(`probe failed: ${(err as Error).message}`);
  }
  nextPoll = Date.now() + EVERY_S * 1000;
  timer = setTimeout(poll, EVERY_S * 1000);
  render();
}

// ── Deploying ───────────────────────────────────────────────────

async function deploy(i: Instance) {
  if (!i.deploy) { say(`${i.name}: no deploy command in fleet.yaml`); return; }
  if (deploying) { say(`busy: ${deploying.name} is still deploying`); return; }
  deploying = { name: i.name, startedAt: Date.now() };
  showLog = true;
  say(`▶ ${i.name}: ${i.deploy}`);
  render();
  const proc = Bun.spawn(["sh", "-c", i.deploy], { cwd: REPO_DIR, stdout: "pipe", stderr: "pipe" });
  const pump = async (stream: ReadableStream<Uint8Array>, prefix: string) => {
    let rest = "";
    for await (const chunk of stream) {
      rest += new TextDecoder().decode(chunk);
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) { say(`${prefix}${l}`); }
      render();
    }
    if (rest.trim()) say(`${prefix}${rest}`);
  };
  await Promise.all([pump(proc.stdout, "  "), pump(proc.stderr, "  ! ")]);
  const code = await proc.exited;
  const took = age(Math.floor((Date.now() - deploying.startedAt) / 1000)) || "<1m";
  say(code === 0 ? `✓ ${i.name} deployed in ${took}` : `✗ ${i.name}: exit ${code} after ${took}`);
  deploying = null;
  await poll();
}

// ── Rendering ───────────────────────────────────────────────────

const ESC = "\x1b[";
const dim = (s: string) => `${ESC}2m${s}${ESC}22m`;
const bold = (s: string) => `${ESC}1m${s}${ESC}22m`;
const red = (s: string) => `${ESC}31m${s}${ESC}39m`;
const green = (s: string) => `${ESC}32m${s}${ESC}39m`;
const yellow = (s: string) => `${ESC}33m${s}${ESC}39m`;
const inverse = (s: string) => `${ESC}7m${s}${ESC}27m`;
const BARS = "▁▂▃▄▅▆▇█";

function spark(name: string): string {
  const h = history.get(name) ?? [];
  const max = Math.max(1, ...h.map((v) => v ?? 0));
  return h.map((v) => (v == null ? red("·") : v === 0 ? dim("▁") : BARS[Math.min(7, Math.ceil((v / max) * 7))])).join("");
}

function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function fit(s: string, width: number): string {
  const len = visibleLength(s);
  return len >= width ? s : s + " ".repeat(width - len);
}

function render() {
  const cols = process.stdout.columns || 120;
  const linesMax = process.stdout.rows || 40;
  const out: string[] = [];
  const secs = Math.max(0, Math.ceil((nextPoll - Date.now()) / 1000));
  const bad = rows.filter(isBad).length;
  const summary = rows.length
    ? bad ? red(`${bad} of ${rows.length} need attention`) : green(`${rows.length} instances ok`)
    : dim("probing…");
  out.push(`${bold("Maurice — tour de contrôle")}   ${summary}   ${dim(`last ${lastPoll ? age(Math.floor((Date.now() - lastPoll) / 1000)) || "<1m" : "—"} ago · next in ${secs}s · every ${EVERY_S}s`)}`);
  out.push("");

  const lines = table(rows);
  const spw = HISTORY;
  out.push(dim(`   ${lines[0]}  ${"errors/1h, last polls".padEnd(spw)}`));
  out.push(dim(`   ${lines[1]}  ${"─".repeat(spw)}`));
  rows.forEach((r, i) => {
    let line = lines[i + 2]!;
    if (r.reach === "down") line = red(line);
    else if (r.status !== "ok") line = yellow(line);
    else if (r.probe === "public") line = dim(line);
    const marker = deploying?.name === r.name ? yellow("⟳") : i === selected ? "▸" : " ";
    const text = ` ${marker} ${line}  ${spark(r.name)}`;
    out.push(i === selected ? inverse(fit(text, cols)) : text);
  });
  out.push("");

  const sel = fleet[selected];
  if (sel) {
    out.push(`${dim("url")} ${sel.url}   ${dim("owner")} ${sel.owner ?? "—"}   ${dim("since")} ${sel.since ?? "—"}`);
    out.push(`${dim("deploy")} ${sel.deploy ? sel.deploy : dim("none — read-only")}`);
  }
  out.push("");

  if (confirming) {
    out.push(yellow(bold(`Deploy ${confirming.name} with "${confirming.deploy}"?  y / n`)));
  } else {
    out.push(dim("↑/↓ select   r probe now   d deploy   l log   q quit"));
  }

  if (showLog) {
    out.push("");
    const room = Math.max(3, linesMax - out.length - 1);
    const tail = log.slice(-room);
    out.push(dim(`── log ${"─".repeat(Math.max(0, cols - 8))}`));
    for (const l of tail) out.push(l);
  }

  const frame = out.slice(0, linesMax).map((l) => {
    // Cut lines that would wrap; a wrapped line breaks the frame.
    let acc = "", n = 0;
    for (const part of l.split(/(\x1b\[[0-9;]*m)/)) {
      if (part.startsWith("\x1b[")) { acc += part; continue; }
      const take = Math.max(0, Math.min(part.length, cols - 1 - n));
      acc += part.slice(0, take); n += take;
    }
    return acc + `${ESC}0m${ESC}K`;
  });
  process.stdout.write(`${ESC}H${frame.join("\n")}\n${ESC}J`);
}

// ── Keys ────────────────────────────────────────────────────────

function onKey(key: string) {
  if (confirming) {
    const target = confirming;
    confirming = null;
    if (key === "y" || key === "Y") void deploy(target);
    else say(`${target.name}: deploy cancelled`);
    render();
    return;
  }
  switch (key) {
    case "q": case "\x03": quit(); return;
    case "\x1b[A": case "k": selected = (selected - 1 + fleet.length) % fleet.length; break;
    case "\x1b[B": case "j": selected = (selected + 1) % fleet.length; break;
    case "r": void poll(); return;
    case "l": showLog = !showLog; break;
    case "d": {
      const i = fleet[selected];
      if (!i) break;
      if (!i.deploy) { say(`${i.name}: no deploy command in fleet.yaml`); break; }
      if (deploying) { say(`busy: ${deploying.name} is still deploying`); break; }
      confirming = i;
      break;
    }
  }
  render();
}

function quit() {
  process.stdout.write(`${ESC}?25h${ESC}?1049l`);
  try { process.stdin.setRawMode(false); } catch {}
  process.exit(0);
}

// ── Main ────────────────────────────────────────────────────────

if (!fleet.length) {
  console.error("ops/fleet.yaml lists no instance");
  process.exit(2);
}
if (argv.includes("--once") || !process.stdin.isTTY) {
  rows = await probeAll(fleet);
  for (const r of rows) history.set(r.name, [r.reach === "down" ? null : r.errors_1h ?? 0]);
  lastPoll = Date.now();
  showLog = false;
  render();
  process.exit(rows.some(isBad) ? 1 : 0);
}
process.stdout.write(`${ESC}?1049h${ESC}?25l`);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (k: string) => onKey(k));
process.stdout.on("resize", render);
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
setInterval(render, 1000); // the countdown
say(`watching ${fleet.length} instances every ${EVERY_S}s`);
await poll();
