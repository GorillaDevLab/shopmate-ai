import { describe, expect, it } from "vitest";

const portModule = await import("./port.js").catch(() => null);

describe("resolvePort", () => {
  it("使用 3001 作为默认端口", () => {
    expect(portModule).not.toBeNull();
    if (!portModule) return;

    expect(portModule.resolvePort(undefined)).toBe(3001);
  });

  it("接受有效的 TCP 端口", () => {
    expect(portModule).not.toBeNull();
    if (!portModule) return;

    expect(portModule.resolvePort("4100")).toBe(4100);
  });

  it.each(["0", "65536", "3.14", "abc"])("拒绝无效端口 %s", (value) => {
    expect(portModule).not.toBeNull();
    if (!portModule) return;

    expect(() => portModule.resolvePort(value)).toThrow("PORT 必须是 1 到 65535 之间的整数");
  });
});
