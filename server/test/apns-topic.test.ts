import { describe, expect, it } from "bun:test";
import { apnsTopicFor } from "../src/services/apns";

describe("apnsTopicFor", () => {
  it("routes Carnet tokens to Carnet's bundle id", () => {
    expect(apnsTopicFor("carnet-ios")).toBe("eu.chezmaurice.carnet");
  });
  it("routes everything else to the Maurice app", () => {
    expect(apnsTopicFor("ios")).toBe("eu.chezmaurice.app");
    expect(apnsTopicFor(null)).toBe("eu.chezmaurice.app");
    expect(apnsTopicFor(undefined)).toBe("eu.chezmaurice.app");
  });
});
