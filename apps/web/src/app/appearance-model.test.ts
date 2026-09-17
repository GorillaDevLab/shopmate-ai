import { afterEach, expect, it, vi } from "vitest";
import {
  APPEARANCE_STORAGE_KEY,
  APPEARANCE_INIT_SCRIPT,
  DEFAULT_APPEARANCE,
  parseAppearance,
  readAppearance,
  writeAppearance,
  materialVariables,
} from "./appearance-model";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("无配置或损坏配置默认冷静", () => {
  expect(readAppearance().settings.mode).toBe("calm");
  localStorage.setItem(APPEARANCE_STORAGE_KEY, "invalid json");
  expect(readAppearance().settings.mode).toBe("calm");
  expect(readAppearance().error).toBeTruthy();
});

it.each([
  { version: 2 },
  { mode: "anything" },
  { page: { ...DEFAULT_APPEARANCE.page, primary: "url(https://bad.test)" } },
  { page: { ...DEFAULT_APPEARANCE.page, speed: Infinity } },
  { widgets: { ...DEFAULT_APPEARANCE.widgets, opacity: 101 } },
  {
    cards: Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [String(i), DEFAULT_APPEARANCE.widgets]),
    ),
  },
])("拒绝不可信配置 %#", (invalid) => {
  const value = { ...DEFAULT_APPEARANCE, mode: "vivid", ...invalid };
  expect(parseAppearance(value).mode).toBe("calm");
});

it("保存模式时不丢单卡装饰", () => {
  const settings = {
    ...DEFAULT_APPEARANCE,
    mode: "vivid" as const,
    cards: { sales: { ...DEFAULT_APPEARANCE.widgets, primary: "#ff8800" } },
  };
  expect(writeAppearance(settings)).toBe("");
  expect(readAppearance().settings).toEqual(settings);
  writeAppearance({ ...settings, mode: "calm" });
  expect(readAppearance().settings.cards.sales.primary).toBe("#ff8800");
});

it("存储失败返回明确错误", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(writeAppearance(DEFAULT_APPEARANCE)).toContain("当前浏览器");
});

it("CSS 变量只包含经过校验的材质值", () => {
  expect(materialVariables(DEFAULT_APPEARANCE.widgets)).toMatchObject({
    "--material-primary": DEFAULT_APPEARANCE.widgets.primary,
    "--material-play": "running",
  });
});

it("首屏恢复和运行时验证一致", () => {
  for (const value of [
    DEFAULT_APPEARANCE,
    { ...DEFAULT_APPEARANCE, mode: "vivid" },
    { ...DEFAULT_APPEARANCE, mode: "vivid", page: {} },
    { version: 99, mode: "vivid" },
  ]) {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(value));
    Function(APPEARANCE_INIT_SCRIPT)();
    expect(document.documentElement.dataset.appearance).toBe(parseAppearance(value).mode);
  }
});
