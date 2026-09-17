"use client";

import { MATERIAL_PRESETS, materialVariables, type Material } from "./appearance-model";

type Props = { value: Material; onChange: (value: Material) => void };
export function MaterialPreview({ value, title }: { value: Material; title: string }) {
  return (
    <div className="material-preview appearance-surface" style={materialVariables(value)}>
      <span className="material-preview-eyebrow">LIVE MATERIAL / 实时预览</span>
      <strong>{title}</strong>
      <p>让每一次工作，都有一点不一样。</p>
      <span className="material-preview-glyph" aria-hidden="true">
        ✳
      </span>
    </div>
  );
}

export function MaterialPresets({ value, onChange }: Props) {
  return (
    <fieldset className="studio-fieldset">
      <legend>
        灵感配色 <span>PALETTE</span>
      </legend>
      <div className="material-presets">
        {MATERIAL_PRESETS.map((preset) => {
          const selected =
            value.primary === preset.primary &&
            value.secondary === preset.secondary &&
            value.shade === preset.shade;
          return (
            <button
              type="button"
              key={preset.name}
              aria-pressed={selected}
              onClick={() =>
                onChange({
                  ...value,
                  primary: preset.primary,
                  secondary: preset.secondary,
                  shade: preset.shade,
                })
              }
            >
              <span
                style={{
                  background: `radial-gradient(at 12% 20%, ${preset.primary}, transparent 65%), radial-gradient(at 90% 90%, ${preset.secondary}, ${preset.shade})`,
                }}
              />
              {preset.name}
              {selected && <b aria-hidden="true">✓</b>}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function MaterialColors({ value, onChange }: Props) {
  return (
    <fieldset className="studio-fieldset">
      <legend>
        调出你的颜色 <span>COLOR</span>
      </legend>
      <div className="material-colors">
        {(
          [
            { key: "primary", name: "主色" },
            { key: "secondary", name: "辅色" },
            { key: "shade", name: "暗部" },
          ] as const
        ).map((item) => (
          <label key={item.key}>
            <span>{item.name}</span>
            <input
              type="color"
              value={value[item.key]}
              aria-label={item.name}
              onChange={(event) => onChange({ ...value, [item.key]: event.target.value })}
            />
            <small>{value[item.key].toUpperCase()}</small>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function MaterialMotion({ value, onChange }: Props) {
  const sliders = [
    { key: "opacity", label: "材质浓度", min: 20, max: 100, step: 1, unit: "%" },
    { key: "glow", label: "流光强度", min: 0, max: 100, step: 1, unit: "%" },
    { key: "speed", label: "流动速度", min: 0.25, max: 2, step: 0.25, unit: "×" },
  ] as const;
  return (
    <fieldset className="studio-fieldset">
      <legend>
        材质与呼吸 <span>FEEL</span>
      </legend>
      {sliders.map((item) => (
        <label className="material-slider" key={item.key}>
          <span>
            {item.label}
            <output>
              {value[item.key]}
              {item.unit}
            </output>
          </span>
          <input
            type="range"
            min={item.min}
            max={item.max}
            step={item.step}
            value={value[item.key]}
            aria-label={item.label}
            onChange={(event) => onChange({ ...value, [item.key]: Number(event.target.value) })}
          />
        </label>
      ))}
      <label className="material-motion-toggle">
        <span>
          流光动画<small>关闭后保留静态材质</small>
        </span>
        <input
          type="checkbox"
          checked={value.motion}
          onChange={(event) => onChange({ ...value, motion: event.target.checked })}
        />
      </label>
      <p className="studio-hint">系统开启“减少动态效果”时，自动使用静态效果。</p>
    </fieldset>
  );
}
