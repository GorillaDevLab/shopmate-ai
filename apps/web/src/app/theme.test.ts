import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { THEME_INIT_SCRIPT } from "./theme";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeStorageError;
});
afterEach(() => vi.restoreAllMocks());

it.each([null, "invalid", "<script>alert(1)</script>", "terracotta", "purple"])(
  "首屏只恢复白名单主题 %s",
  (value) => {
    if (value !== null) localStorage.setItem("shopmate-theme", value);
    window.eval(THEME_INIT_SCRIPT);
    expect(document.documentElement.dataset.theme).toBe(
      value === "terracotta" ? "terracotta" : "purple",
    );
  },
);
it("读取被阻止时首屏安全回退并记录可见提示状态", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => window.eval(THEME_INIT_SCRIPT)).not.toThrow();
  expect(document.documentElement.dataset.theme).toBe("purple");
  expect(document.documentElement.dataset.themeStorageError).toBe("true");
});
