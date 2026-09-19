import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugReportService } from "./debug-report.module.js";
const context = { userId: "tester", merchantId: "merchant", permissions: [] } as const;
const report = { description: "", device: "iPhone", info: {}, logs: [] };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function configure() {
  vi.stubEnv("ENABLE_DEBUG_REPORT", "true");
  vi.stubEnv("DEBUG_REPORT_EMAIL_API_KEY", "test-only");
  vi.stubEnv("DEBUG_REPORT_EMAIL_FROM", "debug@example.com");
}
describe("debug report delivery", () => {
  it("disabled endpoint never sends", async () => {
    vi.stubEnv("ENABLE_DEBUG_REPORT", "false");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(new DebugReportService().send(context, report)).rejects.toMatchObject({
      status: 404,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses a fixed recipient, sanitizes twice, and limits attempts", async () => {
    configure();
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const service = new DebugReportService();
    await service.send(context, { ...report, description: "token=private-value" });
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.to).toEqual(["1719379411@qq.com"]);
    expect(body.text).not.toContain("private-value");
    await service.send(context, report);
    await expect(service.send(context, report)).rejects.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects oversized and invalid data before provider calls", async () => {
    configure();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      new DebugReportService().send(context, { ...report, description: "x".repeat(70000) }),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      new DebugReportService().send(context, { ...report, extra: true }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("hides provider errors and credentials", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret provider body")));
    await expect(new DebugReportService().send(context, report)).rejects.toThrow(
      "Failed to send debug report.",
    );
  });
});
