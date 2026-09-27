"use client";

import { useAppearance } from "./appearance-provider";
import { materialVariables } from "./appearance-model";
import { AppearanceStudio } from "./appearance-studio";

export function AppearanceControls() {
  const { settings, setMode, ready, error, studioOpen, openStudio, closeStudio } = useAppearance();
  return (
    <div className="appearance-controls">
      <div className="appearance-mode-switch" role="group" aria-label="工作台模式">
        <span className="appearance-mode-indicator" data-mode={settings.mode} aria-hidden="true" />
        {(
          [
            { mode: "calm", label: "冷静", icon: "◐" },
            { mode: "vivid", label: "灵动", icon: "✧" },
          ] as const
        ).map((item) => (
          <button
            key={item.mode}
            type="button"
            aria-pressed={settings.mode === item.mode}
            disabled={!ready}
            onClick={() => setMode(item.mode)}
          >
            <span aria-hidden="true">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>
      {settings.mode === "vivid" && (
        <button
          type="button"
          className="appearance-studio-trigger"
          aria-haspopup="dialog"
          onClick={openStudio}
        >
          <span aria-hidden="true">✺</span> 装饰工作台
        </button>
      )}
      {error && (
        <p className="appearance-storage-error" role="status">
          {error}
        </p>
      )}
      {studioOpen && <AppearanceStudio onClose={closeStudio} />}
    </div>
  );
}

export function AppearanceAmbient() {
  const { settings } = useAppearance();
  return (
    <div
      className="appearance-ambient"
      aria-hidden="true"
      style={materialVariables(settings.page)}
    />
  );
}
