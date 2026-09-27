"use client";

import type { ProductCopyOutput, ProductCopyType } from "@shopmate/contracts";
import { useEffect, useState, type FormEvent } from "react";

import { AppShell } from "../app-shell";
import { type ChatMessage, useChatSession } from "../chat-session";

// 与聊天接口 schema 的 content 上限一致，防止从 URL 预填超长内容。
const MESSAGE_MAX_LENGTH = 2000;

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

  // 顶部搜索以 GET /chat?q= 跳转过来：只预填输入框，不自动发送，由商家确认后再提交。
  useEffect(() => {
    const query = new URLSearchParams(window.location.search).get("q")?.trim();
    if (query) setInput(query.slice(0, MESSAGE_MAX_LENGTH));
  }, [setInput]);

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

    void submit(buildProductCopyPrompt(normalizedProductId, option));
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
    <AppShell active="chat" title="AI 对话">
      <div className="mx-auto w-full max-w-6xl">
        <div className="mb-4 md:mb-6">
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">AI 经营助手</h1>

          <p className="mt-1 max-w-2xl text-sm leading-6 text-app-muted">
            查询库存、热销和销售趋势，也可以根据真实商品信息生成五类中文营销文案。
          </p>
        </div>

        <div className="grid grid-cols-1 items-start gap-4 md:gap-6 xl:grid-cols-3">
          <section
            className="dashboard-panel flex min-h-[520px] flex-col p-4 md:p-6 xl:col-span-2"
            aria-label="聊天记录"
          >
            <div className="flex flex-wrap gap-2 border-b border-app-line pb-4">
              {examples.map((example) => (
                <button
                  key={example.label}
                  type="button"
                  className="btn-secondary min-h-10 px-3"
                  onClick={() => setInput(example.prompt)}
                >
                  {example.label}
                </button>
              ))}
            </div>

            <ChatMessages
              messages={messages}
              isSending={isSending}
              copyFeedback={copyFeedback}
              error={error}
              onRetry={() => void retry()}
              onCopy={(copy) => void copyProductCopy(copy)}
            />

            <ChatComposer
              input={input}
              isSending={isSending}
              onInput={setInput}
              onSubmit={handleSubmit}
            />
          </section>

          <section className="dashboard-panel p-4 md:p-6" aria-label="商品文案生成">
            <h2 className="text-sm font-semibold tracking-tight md:text-base">商品营销文案</h2>

            <p className="mt-1 text-sm leading-6 text-app-muted">
              输入当前商家下真实存在的商品 ID，再选择需要生成的文案类型。
            </p>

            <div className="mt-4">
              <label className="text-sm font-medium" htmlFor="copy-product-id">
                商品 ID
              </label>

              <input
                id="copy-product-id"
                className="app-input mt-2 min-h-11 w-full px-3"
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
                placeholder="例如：product-001"
                maxLength={128}
                disabled={isSending}
              />
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {copyOptions.map((option) => (
                <button
                  key={option.type}
                  type="button"
                  className="btn-secondary min-h-10 px-3"
                  disabled={isSending || !productId.trim()}
                  onClick={() => requestProductCopy(option)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

function ChatMessages({
  messages,
  isSending,
  copyFeedback,
  error,
  onRetry,
  onCopy,
}: {
  readonly messages: readonly ChatMessage[];
  readonly isSending: boolean;
  readonly copyFeedback: string | null;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly onCopy: (copy: ProductCopyOutput) => void;
}) {
  return (
    <div className="space-y-4 py-5" aria-live="polite">
      {messages.length === 0 && (
        <p className="py-16 text-center text-sm text-app-muted">
          可以查询经营数据，也可以在文案面板选择一种商品营销文案。
        </p>
      )}

      {messages.map((message, index) => (
        <div
          key={`${message.role}-${index}`}
          className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
        >
          {message.role === "assistant" ? (
            <div className="max-w-[85%] space-y-3">
              <p className="whitespace-pre-wrap rounded-xl bg-gray-100 px-4 py-3 text-sm leading-6 text-app-text">
                {message.content}
              </p>

              {message.productCopy && (
                <ProductCopyCard
                  copy={message.productCopy}
                  onCopy={() => onCopy(message.productCopy!)}
                />
              )}
            </div>
          ) : (
            <p className="max-w-[85%] whitespace-pre-wrap rounded-xl bg-brand px-4 py-3 text-sm leading-6 text-white">
              {message.content}
            </p>
          )}
        </div>
      ))}

      {isSending && (
        <p className="text-sm text-app-muted" role="status">
          正在整理经营数据…
        </p>
      )}

      {copyFeedback && (
        <p className="text-sm font-medium text-brand" role="status">
          {copyFeedback}
        </p>
      )}

      {error && (
        <div className="flex items-center gap-3" role="alert">
          <p className="text-sm text-danger">{error}</p>

          <button type="button" className="btn-secondary min-h-10 px-3" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
    </div>
  );
}

function ChatComposer({
  input,
  isSending,
  onInput,
  onSubmit,
}: {
  readonly input: string;
  readonly isSending: boolean;
  readonly onInput: (value: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="mt-auto flex gap-2 border-t border-app-line pt-4" onSubmit={onSubmit}>
      <label className="sr-only" htmlFor="chat-message">
        消息
      </label>

      <input
        id="chat-message"
        className="app-input min-h-11 min-w-0 flex-1 px-3"
        value={input}
        onChange={(event) => onInput(event.target.value)}
        placeholder="例如：最近哪款商品卖得最好？"
        maxLength={MESSAGE_MAX_LENGTH}
        disabled={isSending}
      />

      <button
        className="btn-primary min-h-11 px-4"
        type="submit"
        disabled={isSending || !input.trim()}
        aria-busy={isSending}
      >
        发送消息
      </button>
    </form>
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
    <article className="rounded-xl border border-app-line bg-app-surface p-4">
      <p className="text-xs font-medium text-app-muted">生成结果</p>

      <h3 className="mt-2 text-base font-semibold tracking-tight">{copy.title}</h3>

      <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{copy.body}</p>

      {copy.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {copy.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-brand-soft px-2 py-1 text-xs font-medium text-brand"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      <button type="button" className="btn-secondary mt-4 min-h-10 px-3" onClick={onCopy}>
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
