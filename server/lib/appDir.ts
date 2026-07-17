/**
 * The Maurice application directory — the single definition of where app-owned
 * state lives: maurice.db, avatars/, images/, files/, uploads/.
 *
 * This is deliberately NOT the data-api's [paths] data_dir from config.toml,
 * which points somewhere else (akita.db, compte.db, recommendations.db). The two
 * coincide only when MAURICE_DATA_DIR is set — as every test and the demo seed
 * do — which is why a mismatch between them survives the test suite and only
 * bites a config.toml-driven dev or prod setup.
 *
 * Keep this module free of side effects (no mkdir, no Database) so any caller
 * can ask where a file lives without booting a schema.
 */

import { join } from "node:path";

/** Root of the application directory. Callers are responsible for creating it. */
export function getAppDir(): string {
  return process.env.MAURICE_DATA_DIR || join(process.env.HOME || "/tmp", ".maurice");
}

/** Path to maurice.db, wherever the app directory currently resolves to. */
export function getMauriceDbPath(): string {
  return join(getAppDir(), "maurice.db");
}
