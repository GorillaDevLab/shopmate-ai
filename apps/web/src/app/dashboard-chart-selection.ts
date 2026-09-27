"use client";
import { useState } from "react";
type SelectionState = { signature: string; pinned?: string; transient?: string };

export function useChartSelection(keys: readonly string[]) {
  const signature = JSON.stringify(keys);
  const [stored, setStored] = useState<SelectionState>({ signature });
  let state = stored;
  if (stored.signature !== signature) {
    state = {
      signature,
      pinned: stored.pinned && keys.includes(stored.pinned) ? stored.pinned : undefined,
      transient: stored.transient && keys.includes(stored.transient) ? stored.transient : undefined,
    };
    setStored(state);
  }
  const update = (next: Partial<SelectionState>) =>
    setStored((current) => ({ ...current, signature, ...next }));
  return {
    active: state.transient ?? state.pinned,
    pinned: state.pinned,
    preview: (key: string) => update({ transient: key }),
    clearPreview: () => update({ transient: undefined }),
    toggle: (key: string) =>
      update({ transient: undefined, pinned: state.pinned === key ? undefined : key }),
    select: (key?: string) => update({ transient: undefined, pinned: key }),
  };
}
