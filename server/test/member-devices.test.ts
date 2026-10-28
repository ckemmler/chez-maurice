// What an app says of the device it runs on, kept per install and member.
import { describe, expect, test } from "bun:test";

const { parseDeviceReport, recordDevice, listDevices } = await import("../src/services/memberDevices");
const { MEMBER } = await import("./_member");

describe("member devices", () => {
  test("a report is kept, and a second one from the same install updates it", () => {
    const r = parseDeviceReport({ install_id: "3f1c2a9e-0000-4000-8000-000000000001", platform: "iOS", model: "iPhone17,1", os_version: "26.0.1", app: "maurice", app_version: "1.0.0 (24)" })!;
    recordDevice(MEMBER.id, r);
    recordDevice(MEMBER.id, { ...r, os_version: "26.1" });
    const rows = listDevices(MEMBER.id) as any[];
    expect(rows.filter((d) => d.model === "iPhone17,1")).toHaveLength(1);
    expect(rows.find((d) => d.model === "iPhone17,1").os_version).toBe("26.1");
  });

  test("what is not a report is refused, and odd fields are dropped", () => {
    expect(parseDeviceReport({ install_id: "x", platform: "iOS" })).toBeNull();
    expect(parseDeviceReport({ install_id: "3f1c2a9e-0000-4000-8000-000000000002", platform: "PalmOS" })).toBeNull();
    expect(parseDeviceReport({ install_id: "3f1c2a9e-0000-4000-8000-000000000002", platform: "Android", model: "<b>Pixel</b>" })!.model).toBeNull();
  });
});
