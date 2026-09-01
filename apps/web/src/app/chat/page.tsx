"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";

import { sendChatMessage } from "../chat-api";

type ChatMessage = { readonly role: "user" | "assistant"; readonly content: string };

const examples = [
  { label: "查库存", prompt: "请查询当前库存" },
  { label: "看热销", prompt: "请告诉我最近热销商品" },
  { label: "看趋势", prompt: "请分析最近销售趋势" },
] as const;

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFailed, setLastFailed] = useState<string | null>(null);

  async function submit(content = input) {
    const prompt = content.trim();
    if (!prompt || isSending) return;
    setInput("");
    setError(null);
    setLastFailed(null);
    setMessages((current) => [...current, { role: "user", content: prompt }]);
    setIsSending(true);
    try {
      const reply = await sendChatMessage(prompt);
      setMessages((current) => [...current, reply]);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "AI 服务暂时不可用，请稍后重试");
      setLastFailed(prompt);
    } finally {
      setIsSending(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  return (
    <main className="min-h-dvh bg-app-bg px-4 py-5 text-app-text sm:px-8 lg:py-8">
      <div className="mx-auto w-full max-w-3xl">
        <header className="flex items-center justify-between border-b border-app-line pb-4">
          <Link
            className="inline-flex min-h-11 items-center gap-3 rounded-full focus-ring"
            href="/"
          >
            <span className="grid size-9 place-items-center rounded-xl bg-brand text-lg font-bold text-white">
              S
            </span>
            <span className="text-base font-bold tracking-tight">ShopMate AI</span>
          </Link>
          <Link
            className="min-h-11 rounded-xl px-3 py-2 text-sm font-semibold text-brand hover:bg-brand-soft"
            href="/"
          >
            返回看板
          </Link>
        </header>

        <section className="mt-8">
          <p className="text-xs font-semibold tracking-[0.12em] text-app-muted">中文经营助手</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">AI 经营助手</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-app-muted">
            用自然语言查询库存、热销商品和销售趋势。数据仅来自当前商家账号。
          </p>
        </section>

        <section className="dashboard-panel mt-6 min-h-[420px] p-4 sm:p-6" aria-label="聊天记录">
          <div className="flex flex-wrap gap-2 border-b border-app-line pb-4">
            {examples.map((example) => (
              <button
                key={example.label}
                type="button"
                className="min-h-10 rounded-xl border border-app-line bg-app-surface px-3 text-sm font-semibold hover:border-brand hover:bg-brand-soft"
                onClick={() => setInput(example.prompt)}
              >
                {example.label}
              </button>
            ))}
          </div>
          <div className="space-y-4 py-5" aria-live="polite">
            {messages.length === 0 && (
              <p className="py-16 text-center text-sm text-app-muted">
                从上面的经营问题开始，或直接输入你的问题。
              </p>
            )}
            {messages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <p
                  className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === "user" ? "bg-brand text-white" : "bg-brand-soft text-app-text"}`}
                >
                  {message.content}
                </p>
              </div>
            ))}
            {isSending && (
              <p className="text-sm text-app-muted" role="status">
                正在整理经营数据…
              </p>
            )}
            {error && (
              <div className="flex items-center gap-3" role="alert">
                <p className="text-sm text-danger">{error}</p>
                {lastFailed && (
                  <button
                    type="button"
                    className="min-h-10 rounded-xl border border-app-line px-3 text-sm font-semibold hover:bg-brand-soft"
                    onClick={() => void submit(lastFailed)}
                  >
                    重试
                  </button>
                )}
              </div>
            )}
          </div>
          <form className="flex gap-2 border-t border-app-line pt-4" onSubmit={handleSubmit}>
            <label className="sr-only" htmlFor="chat-message">
              消息
            </label>
            <input
              id="chat-message"
              className="min-h-11 min-w-0 flex-1 rounded-xl border border-app-line bg-app-bg px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="例如：最近哪款商品卖得最好？"
              disabled={isSending}
            />
            <button
              className="min-h-11 rounded-xl bg-brand px-4 text-sm font-bold text-white hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-60"
              type="submit"
              disabled={isSending || !input.trim()}
              aria-busy={isSending}
            >
              发送消息
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
