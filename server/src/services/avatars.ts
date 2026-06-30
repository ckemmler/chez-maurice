import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { dataDir } from "../db";

// Household member photo avatars. Stored as files under <dataDir>/avatars and
// served (no auth, like chat images) from /api/avatars/<filename> so the client
// can render them with a plain image request. A user with no avatar falls back
// to an initial on their avatar_color.

export const avatarsDir = join(dataDir, "avatars");
mkdirSync(avatarsDir, { recursive: true });

/** Save a base64 data-URI avatar and return its public path (/api/avatars/…). */
export function saveAvatar(dataUri: string): { filename: string; url: string } {
  const match = dataUri.match(/^data:image\/(\w+);base64,(.+)$/s);
  if (!match) throw new Error("Invalid image data URI");
  const ext = match[1] === "png" ? "png" : "jpg";
  const buffer = Buffer.from(match[2]!, "base64");
  const filename = `${crypto.randomUUID()}.${ext}`;
  writeFileSync(join(avatarsDir, filename), buffer);
  return { filename, url: `/api/avatars/${filename}` };
}
