import { afterEach, expect, it, vi } from "vitest";
import { isMobileDebugEnabled, mobileDebugScript } from "./mobile-debug-script";

const originalFetch = window.fetch;
const originalConsole = console.error;
afterEach(() => {
  window.fetch = originalFetch;
  console.error = originalConsole;
  window.localStorage.removeItem("shopmate_debug_enabled");
  vi.unstubAllEnvs();
});

it("keeps temporary diagnostics enabled unless deployment explicitly disables them", () => {
  expect(isMobileDebugEnabled(undefined)).toBe(true);
  expect(isMobileDebugEnabled("true")).toBe(true);
  expect(isMobileDebugEnabled("false")).toBe(false);
});

it("shows sanitized diagnostics locally before hydration without making a report request", async () => {
  vi.stubEnv("NEXT_PUBLIC_APP_BUILD", "test-build");
  const response = new Response("private customer body", { status: 500 });
  const fetch = vi.fn().mockResolvedValue(response);
  window.fetch = fetch;
  const script = mobileDebugScript();
  window.eval(script);
  document.dispatchEvent(new Event("DOMContentLoaded"));
  window.dispatchEvent(
    new ErrorEvent("error", {
      message: "token=private-value",
      filename: "https://example.com/app.js?key=private-value",
      lineno: 2,
    }),
  );
  const result = await window.fetch("/api/v1/example?token=private-value");
  expect(await result.text()).toBe("private customer body");
  const host = document.querySelector("#mobile-debug-report")!;
  const root = host.shadowRoot!;
  root.querySelector<HTMLButtonElement>("#open")!.click();
  expect(root.querySelector("h2")!.textContent).toBe("页面诊断");
  expect(root.querySelector("#details")!.textContent).not.toContain("private-value");
  expect(root.querySelector("#details")!.textContent).not.toContain("private customer body");
  root.querySelector<HTMLButtonElement>("#copy")!.click();
  expect(root.querySelector("#status")!.textContent).toBe("请直接截图发送给开发者");
  expect(fetch).toHaveBeenCalledTimes(1);
  root.querySelector<HTMLButtonElement>("#disable")!.click();
  expect(root.querySelector<HTMLButtonElement>("#open")!.hidden).toBe(true);
  window.dispatchEvent(new Event("pagehide"));
  host.remove();
});
