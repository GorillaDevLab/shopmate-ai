export type Theme = "terracotta" | "purple";
export const THEME_STORAGE_KEY = "shopmate-theme";
export const THEME_STORAGE_ERROR = "当前浏览器无法保存外观设置，刷新后将恢复默认主题。";

export function themeValue(value: unknown): Theme {
  return value === "purple" ? "purple" : "terracotta";
}

// Fixed code only: restore before paint without interpolating browser-controlled storage.
export const THEME_INIT_SCRIPT = `(() => {
  const root = document.documentElement;
  try {
    const value = localStorage.getItem('shopmate-theme');
    root.dataset.theme = value === 'purple' ? 'purple' : 'terracotta';
  } catch {
    root.dataset.theme = 'terracotta';
    root.dataset.themeStorageError = 'true';
  }
})();`;

export function applyTheme(theme: Theme): string {
  const safeTheme = themeValue(theme);
  document.documentElement.dataset.theme = safeTheme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, safeTheme);
    delete document.documentElement.dataset.themeStorageError;
    return "";
  } catch {
    document.documentElement.dataset.themeStorageError = "true";
    return THEME_STORAGE_ERROR;
  }
}
