"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_APPEARANCE,
  readAppearance,
  validateAppearance,
  writeAppearance,
  type Appearance,
  type AppearanceMode,
} from "./appearance-model";

export type AppearanceCard = { id: string; title: string };
type AppearanceContextValue = {
  settings: Appearance;
  ready: boolean;
  error: string;
  cards: AppearanceCard[];
  setCards: (cards: AppearanceCard[]) => void;
  setMode: (mode: AppearanceMode) => void;
  save: (settings: Appearance) => string;
  studioOpen: boolean;
  openStudio: () => void;
  closeStudio: () => void;
};
const fallback: AppearanceContextValue = {
  settings: DEFAULT_APPEARANCE,
  ready: false,
  error: "",
  cards: [],
  studioOpen: false,
  setCards: () => undefined,
  setMode: () => undefined,
  save: () => "外观设置尚未就绪",
  openStudio: () => undefined,
  closeStudio: () => undefined,
};
const AppearanceContext = createContext<AppearanceContextValue>(fallback);
export function useAppearance() {
  return useContext(AppearanceContext);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const storage = useAppearanceStorage();
  const [cards, setCards] = useState<AppearanceCard[]>([]);
  const [studioOpen, setStudioOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const openStudio = useCallback(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setStudioOpen(true);
  }, []);
  const closeStudio = useCallback(() => {
    setStudioOpen(false);
    requestAnimationFrame(() => {
      if (opener.current?.isConnected) opener.current.focus();
    });
  }, []);
  useAppearanceDocument(storage.settings.mode, storage.ready);
  return (
    <AppearanceContext.Provider
      value={{ ...storage, cards, setCards, studioOpen, openStudio, closeStudio }}
    >
      {children}
    </AppearanceContext.Provider>
  );
}

function useAppearanceStorage() {
  const [settings, setSettings] = useState(DEFAULT_APPEARANCE);
  const current = useRef(settings);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const restored = readAppearance();
    current.current = restored.settings;
    // Browser-only preferences must hydrate after the matching server render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(restored.settings);
    setError(restored.error);
    setReady(true);
  }, []);
  const save = useCallback((next: Appearance) => {
    if (!validateAppearance(next)) {
      const message = "装饰设置无效或单卡设置已达上限（100 张），请恢复默认后重试。";
      setError(message);
      return message;
    }
    const message = writeAppearance(next);
    current.current = next;
    setSettings(next);
    setError(message);
    return message;
  }, []);
  const setMode = useCallback(
    (mode: AppearanceMode) => {
      save({ ...current.current, mode });
    },
    [save],
  );
  return { settings, ready, error, save, setMode };
}

function useAppearanceDocument(mode: AppearanceMode, ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    document.documentElement.dataset.appearance = mode;
  }, [mode, ready]);
  useEffect(() => {
    const update = () => {
      document.documentElement.dataset.pageHidden = String(document.hidden);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
}
