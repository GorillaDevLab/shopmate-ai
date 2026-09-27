"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_APPEARANCE,
  parseAppearance,
  type Appearance,
  type Material,
} from "./appearance-model";
import { useAppearance } from "./appearance-provider";
import {
  MaterialColors,
  MaterialMotion,
  MaterialPresets,
  MaterialPreview,
} from "./appearance-fields";

function targetMaterial(draft: Appearance, target: string): Material {
  if (target === "page") return draft.page;
  if (target === "widgets") return draft.widgets;
  return draft.cards[target.slice(5)] ?? draft.widgets;
}

export function AppearanceStudio({ onClose }: { onClose: () => void }) {
  const appearance = useAppearance();
  const [draft, setDraft] = useState(() => parseAppearance(appearance.settings));
  const [target, setTarget] = useState("page");
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
    };
  }, []);
  const change = (value: Material) => {
    setDraft((current) =>
      target === "page" || target === "widgets"
        ? { ...current, [target]: value }
        : { ...current, cards: { ...current.cards, [target.slice(5)]: value } },
    );
  };
  const title =
    target === "page"
      ? "整个工作台，都在呼吸"
      : target === "widgets"
        ? "为所有组件，注入灵感"
        : (appearance.cards.find((card) => card.id === target.slice(5))?.title ?? "组件");
  return (
    <dialog
      ref={dialog}
      className="appearance-studio"
      aria-labelledby="studio-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <StudioHeader onClose={onClose} />
      <div className="studio-scroll">
        <label className="studio-target">
          装饰对象
          <select value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="page">主页背景</option>
            <option value="widgets">所有组件（默认材质）</option>
            {appearance.cards.map((card) => (
              <option key={card.id} value={`card:${card.id}`}>
                {card.title}
              </option>
            ))}
          </select>
        </label>
        {!appearance.cards.length && (
          <p className="studio-hint">暂无可选组件；看板加载后可单独装饰。</p>
        )}
        <MaterialPreview value={targetMaterial(draft, target)} title={title} />
        <MaterialPresets value={targetMaterial(draft, target)} onChange={change} />
        <MaterialColors value={targetMaterial(draft, target)} onChange={change} />
        <MaterialMotion value={targetMaterial(draft, target)} onChange={change} />
        <StudioReset draft={draft} target={target} setDraft={setDraft} />
        <p className="studio-hint">仅保存在当前浏览器，不影响经营数据。切回冷静，装饰仍会保留。</p>
      </div>
      <footer className="studio-footer">
        {error && <p role="alert">{error}</p>}
        <button type="button" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="studio-save"
          onClick={() => {
            const message = appearance.save(draft);
            setError(message);
            if (!message) onClose();
          }}
        >
          保存装饰 <span aria-hidden="true">↗</span>
        </button>
      </footer>
    </dialog>
  );
}

function StudioHeader({ onClose }: { onClose: () => void }) {
  return (
    <header className="studio-header">
      <div>
        <p>
          PERSONAL STUDIO <span>灵动实验室</span>
        </p>
        <h2 id="studio-title">让工作台，有你的风格</h2>
      </div>
      <button type="button" aria-label="关闭装饰设置" onClick={onClose}>
        ×
      </button>
    </header>
  );
}

function StudioReset({
  draft,
  target,
  setDraft,
}: {
  draft: Appearance;
  target: string;
  setDraft: (settings: Appearance) => void;
}) {
  const inherit = () => {
    const cards = { ...draft.cards };
    delete cards[target.slice(5)];
    setDraft({ ...draft, cards });
  };
  const resetAll = () => {
    if (window.confirm("恢复全部默认装饰？主页、所有组件和单卡配色都会重置，保存后生效。"))
      setDraft({ ...parseAppearance(null), mode: draft.mode });
  };
  return (
    <div className="studio-reset">
      {target.startsWith("card:") && (
        <button type="button" onClick={inherit}>
          恢复继承全局材质
        </button>
      )}
      {target === "widgets" && (
        <button
          type="button"
          onClick={() => {
            if (window.confirm("将当前默认材质应用到所有组件，并清除单卡装饰？保存后生效。"))
              setDraft({ ...draft, cards: {} });
          }}
        >
          应用到所有组件
        </button>
      )}
      <button
        type="button"
        onClick={() =>
          target === "page" || target === "widgets"
            ? setDraft({ ...draft, [target]: { ...DEFAULT_APPEARANCE[target] } })
            : inherit()
        }
      >
        恢复当前默认
      </button>
      <button type="button" onClick={resetAll}>
        恢复全部默认
      </button>
    </div>
  );
}
