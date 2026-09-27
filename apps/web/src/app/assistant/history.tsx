"use client";
import { useState } from "react";
import { useAssistantWorkspace } from "./provider";
export function AssistantHistory({ onSelect }: { onSelect?: () => void }) {
  const { store, state } = useAssistantWorkspace();
  const [editing, setEditing] = useState("");
  const [title, setTitle] = useState("");
  if (!state.ready)
    return (
      <aside className="assistant-history" aria-label="历史会话">
        <p>验证登录后显示历史会话。</p>
      </aside>
    );
  return (
    <aside className="assistant-history" aria-label="历史会话">
      <div className="assistant-history-heading">
        <strong>你的对话</strong>
        <button
          type="button"
          aria-label="新建对话"
          disabled={!state.ready}
          onClick={() => {
            store.create();
            onSelect?.();
          }}
        >
          ＋
        </button>
      </div>
      <p>仅保存在此浏览器，退出登录后清理</p>
      <div className="assistant-history-list">
        {state.sessions.length === 0 ? (
          <span className="assistant-history-empty">从一个问题开始，记录会出现在这里。</span>
        ) : (
          state.sessions.map((session) => (
            <div
              key={session.id}
              className="assistant-history-item"
              data-active={session.id === state.currentId}
            >
              {editing === session.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    store.rename(session.id, title);
                    setEditing("");
                  }}
                >
                  <input
                    autoFocus
                    aria-label="会话名称"
                    value={title}
                    maxLength={80}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                  <button type="submit">保存</button>
                  <button type="button" onClick={() => setEditing("")}>
                    取消
                  </button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    className="assistant-history-select"
                    aria-current={session.id === state.currentId ? "page" : undefined}
                    onClick={() => {
                      store.select(session.id);
                      onSelect?.();
                    }}
                  >
                    <span>{session.title}</span>
                    <small>
                      {state.runningId === session.id
                        ? "正在处理"
                        : new Date(session.updatedAt).toLocaleDateString("zh-CN")}
                    </small>
                  </button>
                  <details>
                    <summary aria-label={`管理会话：${session.title}`}>···</summary>
                    <div>
                      <button
                        type="button"
                        onClick={() => {
                          setTitle(session.title);
                          setEditing(session.id);
                        }}
                      >
                        重命名
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            window.confirm("删除这段对话？此操作无法恢复，执行中的请求也会停止。")
                          )
                            store.remove(session.id);
                        }}
                      >
                        删除对话
                      </button>
                    </div>
                  </details>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
