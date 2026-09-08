"use client";

import type { ProductCopyOutput, ProductCopyType } from "@shopmate/contracts";
import Link from "next/link";
import { useState, type FormEvent } from "react";

import { useChatSession } from "../chat-session";
import { AssistantMarkdown } from "../assistant-markdown";
import { ChatPending } from "../chat-pending";

const examples = [
  {
    label: "查库存",
    prompt: "请查询当前库存",
  },
  {
    label: "看热销",
    prompt: "请告诉我最近热销商品",
  },
  {
    label: "看趋势",
    prompt: "请分析最近销售趋势",
  },
] as const;

const copyOptions = [
  {
    label: "标题文案",
    type: "TITLE",
  },
  {
    label: "商品描述",
    type: "DESCRIPTION",
  },
  {
    label: "小红书文案",
    type: "XIAOHONGSHU",
  },
  {
    label: "抖音文案",
    type: "DOUYIN",
  },
  {
    label: "通用文案",
    type: "GENERAL",
  },
] satisfies readonly {
  readonly label: string;
  readonly type: ProductCopyType;
}[];

type CopyOption = (typeof copyOptions)[number];

export default function ChatPage() {
  const { messages, input, setInput, isSending, error, submit, retry } = useChatSession();

  const [productId, setProductId] = useState("");
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  function requestProductCopy(option: CopyOption) {
    const normalizedProductId = productId.trim();

    if (!normalizedProductId || isSending) {
      return;
    }

    setCopyFeedback(null);

    void submit(buildProductCopyPrompt(normalizedProductId, option), {
      productId: normalizedProductId,
      copyType: option.type,
    });
  }

  async function copyProductCopy(copy: ProductCopyOutput) {
    try {
      await navigator.clipboard.writeText(formatProductCopyForClipboard(copy));

      setCopyFeedback("文案已复制");
    } catch {
      setCopyFeedback("复制失败，请手动复制");
    }
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
            查询库存、热销和销售趋势，也可以根据真实商品信息生成五类中文营销文案。
          </p>
        </section>

        <section className="dashboard-panel mt-6 p-4 sm:p-5" aria-label="商品文案生成">
          <h2 className="text-base font-bold">商品营销文案</h2>

          <p className="mt-1 text-sm leading-6 text-app-muted">
            输入当前商家下真实存在的商品 ID，再选择需要生成的文案类型。
          </p>

          <div className="mt-4">
            <label className="text-sm font-semibold" htmlFor="copy-product-id">
              商品 ID
            </label>

            <input
              id="copy-product-id"
              className="mt-2 min-h-11 w-full rounded-xl border border-app-line bg-app-bg px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
              placeholder="例如：product-001"
              disabled={isSending}
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {copyOptions.map((option) => (
              <button
                key={option.type}
                type="button"
                className="min-h-10 rounded-xl border border-app-line bg-app-surface px-3 text-sm font-semibold hover:border-brand hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isSending || !productId.trim()}
                onClick={() => requestProductCopy(option)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>

        <section className="dashboard-panel mt-6 min-h-[420px] p-4 sm:p-6" aria-label="聊天记录">
          <div className="flex flex-wrap gap-2 border-b border-app-line pb-4">
            {examples.map((example) => (
              <button
                key={example.label}
                type="button"
                className="min-h-10 rounded-xl border border-app-line bg-app-surface px-3 text-sm font-semibold hover:border-brand hover:bg-brand-soft"
                disabled={isSending}
                onClick={() => setInput(example.prompt)}
              >
                {example.label}
              </button>
            ))}
          </div>

          <div className="space-y-4 py-5" aria-live="polite">
            {messages.length === 0 && (
              <p className="py-16 text-center text-sm text-app-muted">
                可以查询经营数据，也可以从上方选择一种商品营销文案。
              </p>
            )}

            {messages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {message.role === "assistant" ? (
                  <div className="min-w-0 max-w-[100%] space-y-3 sm:max-w-[85%]">
                    <div className="rounded-2xl bg-brand-soft px-4 py-3 text-sm leading-6 text-app-text">
                      <AssistantMarkdown content={message.content} />
                    </div>

                    {message.productCopy && (
                      <ProductCopyCard
                        copy={message.productCopy}
                        onCopy={() => void copyProductCopy(message.productCopy!)}
                      />
                    )}
                  </div>
                ) : (
                  <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-brand px-4 py-3 text-sm leading-6 text-white">
                    {message.content}
                  </p>
                )}
              </div>
            ))}

            {isSending && <ChatPending />}

            {copyFeedback && (
              <p className="text-sm font-semibold text-brand" role="status">
                {copyFeedback}
              </p>
            )}

            {error && (
              <div className="flex items-center gap-3" role="alert">
                <p className="text-sm text-danger">{error}</p>

                <button
                  type="button"
                  className="min-h-10 rounded-xl border border-app-line px-3 text-sm font-semibold hover:bg-brand-soft"
                  onClick={() => void retry()}
                >
                  重试
                </button>
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

function ProductCopyCard({
  copy,
  onCopy,
}: {
  readonly copy: ProductCopyOutput;
  readonly onCopy: () => void;
}) {
  return (
    <article className="rounded-2xl border border-app-line bg-app-surface p-4">
      <p className="text-xs font-semibold tracking-[0.1em] text-app-muted">生成结果</p>

      <h3 className="mt-2 text-lg font-bold">{copy.title}</h3>

      <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{copy.body}</p>

      {copy.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {copy.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-brand-soft px-3 py-1 text-xs font-semibold text-brand"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      <button
        type="button"
        className="mt-4 min-h-10 rounded-xl border border-app-line px-3 text-sm font-semibold hover:border-brand hover:bg-brand-soft"
        onClick={onCopy}
      >
        复制文案
      </button>
    </article>
  );
}

function buildProductCopyPrompt(productId: string, option: CopyOption): string {
  return [
    `请为商品 ${productId} 生成${option.label}。`,
    `商品 ID：${productId}；`,
    `文案类型：${option.type}。`,
    "请使用真实商品信息。",
  ].join("");
}

function formatProductCopyForClipboard(copy: ProductCopyOutput): string {
  const tags = copy.tags.map((tag) => `#${tag}`).join(" ");

  return [copy.title, "", copy.body, ...(tags ? ["", tags] : [])].join("\n");
}
