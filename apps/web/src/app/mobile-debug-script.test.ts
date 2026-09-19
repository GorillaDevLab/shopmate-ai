/* eslint-disable no-console -- Restore the console wrapper after diagnostics testing. */
import { afterEach, expect, it, vi } from "vitest";
import { mobileDebugScript } from "./mobile-debug-script";

const originalFetch = window.fetch;
const originalConsole = console.error;
afterEach(() => {
  window.fetch = originalFetch;
  console.error = originalConsole;
  vi.unstubAllEnvs();
});
it("works before hydration, preserves fetch response, and sends sanitized bounded diagnostics", async () => {
  vi.stubEnv("NEXT_PUBLIC_APP_BUILD", "test-build");
  const response = new Response("private customer body", { status: 500 });
  const fetch = vi.fn().mockResolvedValueOnce(response).mockResolvedValue({ ok: true });
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
  root.querySelector<HTMLButtonElement>("#send")!.click();
  await vi.waitFor(() =>
    expect(root.querySelector("#status")!.textContent).toBe("Debug report sent successfully."),
  );
  const payload = JSON.parse(fetch.mock.calls[1]![1].body);
  expect(payload.logs.some((entry: { type: string }) => entry.type === "error")).toBe(true);
  expect(payload.logs.some((entry: { type: string }) => entry.type === "network")).toBe(true);
  expect(JSON.stringify(payload)).not.toContain("private-value");
  expect(JSON.stringify(payload)).not.toContain("private customer body");
  expect(payload.info.build).toBe("test-build");
  window.dispatchEvent(new Event("pagehide"));
  host.remove();
});
