import type { CSSProperties } from "react";

export type AppearanceMode = "calm" | "vivid";
export type Material = {
  primary: string;
  secondary: string;
  shade: string;
  opacity: number;
  glow: number;
  speed: number;
  motion: boolean;
};
export type Appearance = {
  version: 1;
  mode: AppearanceMode;
  page: Material;
  widgets: Material;
  cards: Record<string, Material>;
};
export const APPEARANCE_STORAGE_KEY = "shopmate-appearance-v1";
export const APPEARANCE_STORAGE_ERROR = "当前浏览器无法保存装饰，设置仅本次生效，刷新后可能丢失。";
export const MATERIAL_PRESETS = [
  { name: "极光青蓝", primary: "#03e6bd", secondary: "#187aff", shade: "#071b24" },
  { name: "日落粉橙", primary: "#ff5cbb", secondary: "#ff922e", shade: "#291021" },
  { name: "电光蓝橙", primary: "#3958ff", secondary: "#ff6b28", shade: "#10142a" },
  { name: "液态银灰", primary: "#d6edec", secondary: "#788f9e", shade: "#141d23" },
] as const;
export const DEFAULT_MATERIAL: Material = {
  primary: MATERIAL_PRESETS[0].primary,
  secondary: MATERIAL_PRESETS[0].secondary,
  shade: MATERIAL_PRESETS[0].shade,
  opacity: 76,
  glow: 65,
  speed: 1,
  motion: true,
};
export const DEFAULT_APPEARANCE: Appearance = {
  version: 1,
  mode: "calm",
  page: { ...DEFAULT_MATERIAL, glow: 80 },
  widgets: { ...DEFAULT_MATERIAL },
  cards: {},
};

// Self-contained so the exact same validator can run before React paints.
export function validateAppearance(value: unknown): value is Appearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const material = (candidate: unknown) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const m = candidate as Record<string, unknown>;
    return (
      Object.keys(m).length === 7 &&
      [m.primary, m.secondary, m.shade].every(
        (color) => typeof color === "string" && /^#[0-9a-f]{6}$/iu.test(color),
      ) &&
      typeof m.motion === "boolean" &&
      typeof m.opacity === "number" &&
      Number.isFinite(m.opacity) &&
      m.opacity >= 20 &&
      m.opacity <= 100 &&
      typeof m.glow === "number" &&
      Number.isFinite(m.glow) &&
      m.glow >= 0 &&
      m.glow <= 100 &&
      typeof m.speed === "number" &&
      Number.isFinite(m.speed) &&
      m.speed >= 0.25 &&
      m.speed <= 2
    );
  };
  if (
    Object.keys(data).length !== 5 ||
    data.version !== 1 ||
    (data.mode !== "calm" && data.mode !== "vivid") ||
    !material(data.page) ||
    !material(data.widgets)
  )
    return false;
  if (!data.cards || typeof data.cards !== "object" || Array.isArray(data.cards)) return false;
  const cards = Object.entries(data.cards);
  return (
    cards.length <= 100 &&
    cards.every(
      ([id, entry]) =>
        /^[a-z0-9_-]{1,128}$/iu.test(id) &&
        !["__proto__", "constructor", "prototype"].includes(id) &&
        material(entry),
    )
  );
}

export function parseAppearance(value: unknown): Appearance {
  return JSON.parse(
    JSON.stringify(validateAppearance(value) ? value : DEFAULT_APPEARANCE),
  ) as Appearance;
}

export function readAppearance(): { settings: Appearance; error: string } {
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (raw === null) return { settings: parseAppearance(null), error: "" };
    const value: unknown = raw.length <= 100_000 ? JSON.parse(raw) : null;
    return {
      settings: parseAppearance(value),
      error: validateAppearance(value) ? "" : "外观设置已失效，已恢复冷静模式。",
    };
  } catch {
    return { settings: parseAppearance(null), error: "无法读取外观设置，已使用冷静模式。" };
  }
}

export function writeAppearance(settings: Appearance): string {
  if (!validateAppearance(settings)) return "装饰设置格式无效，请恢复默认后重新设置。";
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(settings));
    return "";
  } catch {
    return APPEARANCE_STORAGE_ERROR;
  }
}

export function materialVariables(material: Material): CSSProperties {
  return {
    "--material-primary": material.primary,
    "--material-secondary": material.secondary,
    "--material-shade": material.shade,
    "--material-opacity": material.opacity / 100,
    "--material-glow": material.glow / 100,
    "--material-duration": `${20 / material.speed}s`,
    "--material-play": material.motion ? "running" : "paused",
  } as CSSProperties;
}

export const APPEARANCE_INIT_SCRIPT = `(() => {
  const root = document.documentElement;
  try {
    const valid = ${validateAppearance.toString()};
    const raw = localStorage.getItem(${JSON.stringify(APPEARANCE_STORAGE_KEY)});
    const value = raw && raw.length <= 100000 ? JSON.parse(raw) : null;
    root.dataset.appearance = valid(value) ? value.mode : 'calm';
  } catch { root.dataset.appearance = 'calm'; }
})();`;
