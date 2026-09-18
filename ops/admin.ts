#!/usr/bin/env bun
/**
 * The admin console of one instance, opened.
 *
 *   ops/admin.ts                 where each instance's console is, and how
 *   ops/admin.ts aline           forward its port, open the console, hold it
 *   ops/admin.ts aline --print   the ssh line and the url, open nothing
 *
 * A console hands out every provider API key, so the server refuses any
 * request that is not loopback: https://aline.chezmaurice.eu/admin answers
 * 403 and always will. What does work is an ssh forward onto the loopback
 * port that household publishes on its host — `admin:` in ops/fleet.yaml,
 * the port ops/household.sh gave it. This opens that forward, hands the url
 * to the browser, and holds the forward until ^C. The same door is one key
 * away in ops/tower.ts: `a` on the selected instance.
 */
import {
  adminDoor, loopbackAnswers, noDoorReason, openInBrowser, readFleet, table, waitForLoopback,
  type Row,
} from "./fleet";

const args = process.argv.slice(2);
const print = args.includes("--print");
const only = args.filter((a) => !a.startsWith("--"));
const fleet = readFleet();

// No name: the inventory's doors, and which ones are already forwarded.
if (!only.length) {
  const lines = await Promise.all(fleet.map(async (i) => {
    const door = adminDoor(i);
    // Short here, because it is a column; `ops/admin.ts <name>` says it in full.
    if (!door) return [i.name, "—", i.admin ? "its admin: line is unreadable" : "no door — loopback only"];
    if (door.kind === "direct") return [i.name, door.url, "this machine"];
    const open = await loopbackAnswers(door.port);
    return [i.name, door.url, open ? `already forwarded from ${door.host}` : `ssh -L ${door.port}:localhost:${door.port} ${door.host}`];
  }));
  console.log(table([] as Row[], ["instance", "console", "how"], lines).join("\n"));
  process.exit(0);
}

const inst = fleet.find((i) => i.name === only[0]);
if (!inst) {
  console.error(`no instance named "${only[0]}" — see ops/fleet.yaml`);
  process.exit(2);
}
const door = adminDoor(inst);
if (!door) {
  console.error(`${inst.name}: ${noDoorReason(inst)}`);
  console.error(`The port is the one "ops/household.sh list <ssh-host>" prints for it.`);
  process.exit(2);
}

if (print) {
  if (door.kind === "tunnel") console.log(door.forward.join(" "));
  console.log(door.url);
  process.exit(0);
}

let forward: ReturnType<typeof Bun.spawn> | null = null;
if (door.kind === "tunnel" && !(await loopbackAnswers(door.port))) {
  console.log(`▸ ${door.forward.join(" ")}`);
  forward = Bun.spawn(door.forward, { stdout: "inherit", stderr: "inherit" });
  if (!(await waitForLoopback(door.port))) {
    console.error(`✗ nothing answered on :${door.port} — is ${inst.name} running? ops/household.sh list ${door.host}`);
    forward.kill();
    process.exit(1);
  }
}

console.log(`✓ ${inst.name}: ${door.url}`);
if (!openInBrowser(door.url)) console.log("  no browser here — open that url from where yours is.");
if (forward) {
  console.log("  ^C closes the forward.");
  const stop = () => { forward!.kill(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.exit(await forward.exited);
}
