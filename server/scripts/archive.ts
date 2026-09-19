// ============================================================================
// archive.ts — the household archive from the command line.
//
//   bun run scripts/archive.ts export [dest-dir]          write <household>-<stamp>.maurice.tar.gz
//   bun run scripts/archive.ts import <archive> <data-dir> populate a FRESH data dir
//
// The wrappers scripts/export-household.sh and scripts/import-household.sh
// call this with the environment set (MAURICE_CONFIG, MAURICE_GARDENS_DIR)
// the way the services get it. The service itself never opens the live
// database through src/db.ts, so running this beside a serving instance is
// safe: export reads snapshots, import only ever writes into an empty dir.
// ============================================================================
import { resolve } from "node:path";
import { exportHousehold, importHousehold, ArchiveError } from "../src/services/archive";

const [cmd, ...rest] = process.argv.slice(2);

function usage(): never {
  console.error("usage: archive.ts export [dest-dir] | import <archive> <data-dir>");
  process.exit(2);
}

try {
  if (cmd === "export") {
    const outDir = resolve(rest[0] ?? process.cwd());
    const { path, manifest } = await exportHousehold({ outDir });
    console.log(`✓ ${path}`);
    console.log(`  ${manifest.household.name} — ${manifest.members.length} member(s), schema ${manifest.schema_version}, server ${manifest.server_version}`);
    console.log(`  ${manifest.contents.join("  ")}`);
  } else if (cmd === "import") {
    const [archive, into] = rest;
    if (!archive || !into) usage();
    const manifest = await importHousehold(resolve(archive), { into: resolve(into) });
    console.log(`✓ ${manifest.household.name} — ${manifest.members.length} member(s) — restored into ${resolve(into)}`);
    console.log(`  exported ${manifest.created_at} by server ${manifest.server_version}, schema ${manifest.schema_version}`);
    console.log(`  Start a server on it: MAURICE_CONFIG=${resolve(into)}/config.toml MAURICE_GARDENS_DIR=${resolve(into)}/gardens`);
  } else {
    usage();
  }
} catch (e: any) {
  console.error(`✗ ${e instanceof ArchiveError ? e.message : e?.stack ?? e}`);
  process.exit(1);
}
