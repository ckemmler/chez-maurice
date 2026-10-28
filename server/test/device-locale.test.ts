// The device's language, as the app reports it, kept beside the member's own
// choice: what the interface speaks while `locale` is null.
import { afterAll, describe, expect, test } from "bun:test";

const { getUserPreferences, updateUserPreferences } = await import("../src/services/users");
const { MEMBER } = await import("./_member");

describe("device locale", () => {
  afterAll(() => updateUserPreferences(MEMBER.id, { locale: null }));

  test("is kept as its base language, beside a null choice", () => {
    updateUserPreferences(MEMBER.id, { locale: null, device_locale: "fr-BE" });
    expect(getUserPreferences(MEMBER.id)).toMatchObject({ locale: null, device_locale: "fr" });
  });

  test("a value that is not a language leaves the last one", () => {
    updateUserPreferences(MEMBER.id, { device_locale: "<script>" as any });
    expect(getUserPreferences(MEMBER.id).device_locale).toBe("fr");
  });

  test("choosing a language and going back to the device's clears the choice", () => {
    updateUserPreferences(MEMBER.id, { locale: "en" });
    expect(getUserPreferences(MEMBER.id).locale).toBe("en");
    updateUserPreferences(MEMBER.id, { locale: null });
    expect(getUserPreferences(MEMBER.id)).toMatchObject({ locale: null, device_locale: "fr" });
  });
});
