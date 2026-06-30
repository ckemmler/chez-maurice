export type Flag = "public" | "encrypted" | "moc" | "translation" | "archived";

export function hasFlag(data: { flags?: string[] }, flag: Flag): boolean {
  return data.flags?.includes(flag) ?? false;
}

export const isPublic = (d: { flags?: string[] }) => hasFlag(d, "public");
export const isEncrypted = (d: { flags?: string[] }) => hasFlag(d, "encrypted");
export const isMoc = (d: { flags?: string[] }) => hasFlag(d, "moc");
export const isTranslation = (d: { flags?: string[] }) => hasFlag(d, "translation");
export const isDraft = (d: { flags?: string[] }) => !hasFlag(d, "public");
