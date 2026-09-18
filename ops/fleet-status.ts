#!/usr/bin/env bun
/**
 * One command, one table: which version runs where, and what is down.
 *
 *   ops/fleet-status.ts            every instance in ops/fleet.yaml
 *   ops/fleet-status.ts aline      just that one
 *   ops/fleet-status.ts --json     machine-readable, for a cron or a notifier
 *
 * Exit code 1 when any instance is unreachable or degraded, so a cron line
 * can page. The live, interactive face of the same data is ops/tower.ts.
 */
import { isBad, probeAll, readFleet, table } from "./fleet";

const args = process.argv.slice(2);
const json = args.includes("--json");
const only = args.filter((a) => !a.startsWith("--"));
const fleet = readFleet().filter((i) => !only.length || only.includes(i.name));
if (!fleet.length) {
  console.error("no instance matches; see ops/fleet.yaml");
  process.exit(2);
}
const rows = await probeAll(fleet);
if (json) console.log(JSON.stringify(rows, null, 2));
else console.log(table(rows).join("\n"));
process.exit(rows.some(isBad) ? 1 : 0);
