"use client";
import { useState } from "react";
import type { ProductCopyType } from "@shopmate/contracts";
import { useAssistantWorkspace } from "./provider";
export function CopyWorkflow() {
  const [id, setId] = useState("");
  const { store, state } = useAssistantWorkspace();
  const choices: [ProductCopyType, string][] = [
    ["TITLE", "标题文案"],
    ["DESCRIPTION", "商品描述"],
    ["XIAOHONGSHU", "小红书文案"],
    ["DOUYIN", "抖音文案"],
    ["GENERAL", "通用文案"],
  ];
  return (
    <details className="assistant-copy-workflow">
      <summary>商品文案工具</summary>
      <div>
        <label>
          商品 ID
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="输入当前商家的商品 ID"
            maxLength={100}
          />
        </label>
        <div>
          {choices.map(([type, label]) => (
            <button
              key={type}
              disabled={!id.trim() || !state.ready || Boolean(state.runningId)}
              onClick={() =>
                void store.submit(`请为商品 ${id.trim()} 生成${label}`, {
                  productId: id.trim(),
                  copyType: type,
                })
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}
