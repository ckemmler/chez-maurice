// The devices a member uses the apps on, as each app reports itself (see the
// member_devices table in db.ts). Nothing here identifies a device beyond the
// household: the id is one the app made up, the model is the maker's code
// ("iPhone17,1", "SM-S921B"), never a name the member gave it.

import db from "../db";

export const PLATFORMS = ["iOS", "iPadOS", "macOS", "Android", "Windows", "Linux"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type DeviceReport = {
  install_id: string;
  platform: Platform;
  model: string | null;
  os_version: string | null;
  app: string | null;
  app_version: string | null;
};

/** A short printable field, or null: what an app may say of itself. */
const field = (v: unknown, max = 40): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= max && /^[\w .,()+\-/]+$/.test(t) ? t : null;
};

/** The report as the app sent it, checked; null when it is not one. */
export function parseDeviceReport(body: any): DeviceReport | null {
  const install_id = field(body?.install_id, 64);
  const platform = PLATFORMS.find((p) => p === body?.platform);
  if (!install_id || !/^[\w-]{8,64}$/.test(install_id) || !platform) return null;
  return {
    install_id, platform,
    model: field(body.model), os_version: field(body.os_version, 20),
    app: field(body.app, 20), app_version: field(body.app_version, 20),
  };
}

export function recordDevice(userId: string, d: DeviceReport): void {
  db.run(
    `INSERT INTO member_devices (install_id, user_id, platform, model, os_version, app, app_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (install_id, user_id) DO UPDATE SET
       platform = excluded.platform, model = excluded.model, os_version = excluded.os_version,
       app = excluded.app, app_version = excluded.app_version, last_seen_at = datetime('now')`,
    [d.install_id, userId, d.platform, d.model, d.os_version, d.app, d.app_version],
  );
}

export function listDevices(userId: string) {
  return db.query(`SELECT platform, model, os_version, app, app_version, first_seen_at, last_seen_at FROM member_devices WHERE user_id = ? ORDER BY last_seen_at DESC`).all(userId);
}
