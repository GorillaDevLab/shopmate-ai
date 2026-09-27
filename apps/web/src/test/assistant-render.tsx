import { render as renderReact, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { AssistantStoreProvider } from "../app/assistant/provider";
import { AssistantStore } from "../app/assistant/store";

export function render(ui: ReactElement, options?: RenderOptions) {
  const store = new AssistantStore(undefined);
  store.activate({ userId: "test-user", merchantId: "test-merchant" });
  function Wrapper({ children }: { children: ReactNode }) {
    return <AssistantStoreProvider store={store}>{children}</AssistantStoreProvider>;
  }
  return renderReact(ui, { wrapper: Wrapper, ...options });
}
