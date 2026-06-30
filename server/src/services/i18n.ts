import db from "../db";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { STRINGS } from "./i18n-strings";

// Server-side i18n. Two audiences:
//  - the web admin (HTML), language picked per request via langOf(c)
//  - chat-side fallback/error strings sent to the app, in the user's saved locale
// String data lives in the generated ./i18n-strings.ts; this file is the machinery.

export const SUPPORTED = ["en", "fr", "it", "de", "es", "pt", "nl"] as const;
export type Lang = (typeof SUPPORTED)[number];

function isSupported(code: string): code is Lang {
  return (SUPPORTED as readonly string[]).includes(code);
}

function fmt(s: string, args: any[]): string {
  let i = 0;
  return s.replace(/%@|%d|%s/g, () => String(args[i++] ?? ""));
}

/** Translate `key` into `lang`, falling back to English then the key itself.
 *  Positional %@/%d/%s are filled from args, in order. */
export function t(lang: string, key: string, ...args: any[]): string {
  const en = STRINGS.en ?? {};
  const table = (STRINGS as any)[lang] || en;
  const s = table[key] ?? en[key] ?? key;
  return args.length ? fmt(s, args) : s;
}

/** Language for an admin web request: ?lang → cookie → Accept-Language → en. */
export function langOf(c: Context): Lang {
  const q = c.req.query("lang");
  if (q && isSupported(q)) return q;
  const ck = getCookie(c, "maurice_admin_lang");
  if (ck && isSupported(ck)) return ck;
  const al = c.req.header("Accept-Language") || "";
  for (const part of al.split(",")) {
    const code = part.trim().split(";")[0]!.split("-")[0]!.toLowerCase();
    if (isSupported(code)) return code;
  }
  return "en";
}

/** A user's chosen UI language (from saved prefs), for chat-side strings. */
export function userLocale(userId: string | undefined | null): string {
  if (!userId) return "en";
  const row = db
    .query(`SELECT locale FROM user_preferences WHERE user_id = ?`)
    .get(userId) as { locale: string | null } | undefined;
  const id = row?.locale;
  if (!id) return "en";
  const base = id.split("-")[0]!.toLowerCase();
  return isSupported(base) ? base : "en";
}
