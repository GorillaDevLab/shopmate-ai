"use client";
import { useState } from "react";

export function useChartSelection(keys: readonly string[]) {
  const [pinned, setPinned] = useState<string>();
  const [transient, setTransient] = useState<string>();
  const validPinned = pinned && keys.includes(pinned) ? pinned : undefined;
  return {
    active: transient ?? validPinned,
    pinned: validPinned,
    preview: setTransient,
    clearPreview: () => setTransient(undefined),
    toggle: (key: string) => {
      setTransient(undefined);
      setPinned((current) => (current === key ? undefined : key));
    },
    select: setPinned,
  };
}
