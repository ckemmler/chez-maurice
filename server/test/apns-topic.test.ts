import { describe, expect, it } from "bun:test";
import { apnsTopicFor, sendToEitherHost, type ApnsResult } from "../src/services/apns";

describe("apnsTopicFor", () => {
  it("routes Carnet tokens to Carnet's bundle id", () => {
    expect(apnsTopicFor("carnet-ios")).toBe("eu.chezmaurice.carnet.app");
  });
  it("routes everything else to the Maurice app", () => {
    expect(apnsTopicFor("ios")).toBe("eu.chezmaurice.maurice");
    expect(apnsTopicFor(null)).toBe("eu.chezmaurice.maurice");
    expect(apnsTopicFor(undefined)).toBe("eu.chezmaurice.maurice");
  });
});

describe("sendToEitherHost", () => {
  const ok: ApnsResult = { ok: true, status: 200 };
  const bad: ApnsResult = { ok: false, status: 400, reason: "BadDeviceToken" };
  const hosts = ["sandbox", "production"];

  it("tries the other environment when the first refuses the token, and remembers it", async () => {
    const known = new Map<string, string>();
    const tried: string[] = [];
    const post = async (h: string) => { tried.push(h); return h === "production" ? ok : bad; };
    expect(await sendToEitherHost("t", post, hosts, known)).toEqual(ok);
    expect(tried).toEqual(["sandbox", "production"]);
    await sendToEitherHost("t", post, hosts, known);
    expect(tried).toEqual(["sandbox", "production", "production"]);
  });
  it("answers BadDeviceToken only when both environments refuse", async () => {
    const tried: string[] = [];
    const r = await sendToEitherHost("t", async (h) => { tried.push(h); return bad; }, hosts, new Map());
    expect(r).toEqual(bad);
    expect(tried).toEqual(["sandbox", "production"]);
  });
  it("does not try further on any other answer", async () => {
    const tried: string[] = [];
    const other: ApnsResult = { ok: false, status: 400, reason: "DeviceTokenNotForTopic" };
    const r = await sendToEitherHost("t", async (h) => { tried.push(h); return other; }, hosts, new Map());
    expect(r).toEqual(other);
    expect(tried).toEqual(["sandbox"]);
  });
});
