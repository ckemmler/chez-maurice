// What a PIN and an administrator password must not be.
//
// A PIN guards one member's account on a device, behind a brake of ten wrong
// tries per quarter hour (routes/auth.ts): what matters is that it is not one
// of the handful everybody tries first — the same digit, a run, a column of
// the keypad, a pair repeated. The administrator password opens the whole
// household from anywhere on the internet: long rather than clever, and not
// the name it signs in with.

/** The PINs people choose most, past the patterns below (published studies of leaked PINs). */
const COMMON_PINS = new Set([
  "1004", "2000", "6969", "1122", "1313", "2001", "1010", "4321", "1984", "1999", "2580", "0852",
  "121212", "112233", "123321", "159753", "696969", "000000", "123123", "654321", "111222",
]);

export type PinProblem = "format" | "weak";

export function pinProblem(raw: unknown): PinProblem | null {
  const pin = String(raw ?? "").trim();
  if (!/^\d{4,6}$/.test(pin)) return "format";
  const d = [...pin].map(Number);
  if (d.every((x) => x === d[0])) return "weak";                                  // 1111, 000000
  const step = d[1]! - d[0]!;
  if ((step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1]! === step)) return "weak"; // 1234, 9876
  const half = pin.length / 2;
  if (pin.length % 2 === 0 && pin.slice(0, 2).repeat(half) === pin) return "weak"; // 1212, 121212
  if (pin.length === 6 && pin.slice(0, 3) === pin.slice(3)) return "weak";         // 123123
  if (COMMON_PINS.has(pin)) return "weak";
  return null;
}

export const PASSWORD_MIN = 12;

/** Passwords that a guesser tries first, whatever their length. */
const COMMON_PASSWORDS = new Set([
  "password1234", "motdepasse12", "123456789012", "azertyuiop12", "qwertyuiop12", "administrator",
  "chezmaurice1", "maurice12345", "iloveyou1234", "passwordpassword",
]);

export type PasswordProblem = "short" | "name" | "weak";

export function passwordProblem(raw: unknown, username?: string | null): PasswordProblem | null {
  const pw = String(raw ?? "");
  if ([...pw].length < PASSWORD_MIN) return "short";
  const lower = pw.toLowerCase();
  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) return "name";
  if (new Set(lower).size <= 3) return "weak";                                     // aaaaaaaaaaaa, abababababab
  if (COMMON_PASSWORDS.has(lower)) return "weak";
  if (/^(0123456789|1234567890|abcdefghijklmnopqrstuvwxyz|azertyuiop|qwertyuiop)/.test(lower)) return "weak";
  return null;
}
