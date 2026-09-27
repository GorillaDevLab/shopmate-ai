"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { AssistantIdentitySchema } from "@shopmate/contracts";
import { AssistantStore, INITIAL_STATE } from "./store";
import { useAssistantViewport } from "./viewport";

const Context = createContext<AssistantStore | null>(null);
export function AssistantStoreProvider({
  store,
  children,
}: {
  store: AssistantStore;
  children: ReactNode;
}) {
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function AssistantWorkspaceProvider({ children }: { children: ReactNode }) {
  useAssistantViewport();
  const [store] = useState(() => new AssistantStore(browserStorage()));
  const pathname = usePathname();
  useEffect(() => {
    let generation = 0,
      alive = true;
    const authenticate = async () => {
      const current = ++generation;
      if (pathname === "/login") {
        store.clear();
        return;
      }
      store.checking();
      try {
        const response = await fetch("/api/v1/auth/me", {
          credentials: "include",
          cache: "no-store",
        });
        if (!alive || current !== generation) return;
        if (response.status === 401) {
          store.clear();
          return;
        }
        if (!response.ok) throw new Error("无法验证登录状态，请刷新后重试。");
        const identity = AssistantIdentitySchema.parse(await response.json());
        if (alive && current === generation) store.activate(identity);
      } catch (error) {
        if (alive && current === generation)
          store.unavailable(error instanceof Error ? error.message : "无法验证登录状态。");
      }
    };
    const clear = () => {
      generation++;
      store.clear();
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.newValue === null && (event.key === null || store.ownsStorageKey(event.key)))
        clear();
    };
    void authenticate();
    window.addEventListener("focus", authenticate);
    window.addEventListener("shopmate:logout", clear);
    window.addEventListener("pagehide", store.flush);
    window.addEventListener("storage", storageChanged);
    return () => {
      alive = false;
      window.removeEventListener("focus", authenticate);
      window.removeEventListener("shopmate:logout", clear);
      window.removeEventListener("pagehide", store.flush);
      window.removeEventListener("storage", storageChanged);
      store.flush();
    };
  }, [store, pathname]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
function browserStorage() {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
export function useAssistantWorkspace() {
  const store = useContext(Context);
  if (!store) throw new Error("AssistantWorkspaceProvider is required");
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, () => INITIAL_STATE);
  return {
    store,
    state,
    current: state.ready ? state.sessions.find((s) => s.id === state.currentId) : undefined,
  };
}
