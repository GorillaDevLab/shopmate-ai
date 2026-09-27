"use client";

import type {
  ProductCopyOutput,
  ProductCopyRequest,
  DashboardInsightPreviewResponse,
} from "@shopmate/contracts";
import { useRef, useState } from "react";

import { sendChatMessage } from "./chat-api";

export type ChatMessage = {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly productCopy?: ProductCopyOutput;
  readonly insightPreview?: DashboardInsightPreviewResponse;
};

type ChatFailure = {
  readonly message: string;
  readonly prompt: string;
  readonly retryable: boolean;
  readonly productCopy?: ProductCopyRequest;
};

type ChatSessionOptions = {
  readonly resolveMessage?: (
    prompt: string,
    history: ChatMessage[],
  ) => Promise<ChatMessage | undefined>;
};

export function useChatSession(options: ChatSessionOptions = {}) {
  const inFlight = useRef(false);
  // Only completed turns enter context; failed requests and retries cannot duplicate it.
  const completed = useRef<ChatMessage[]>([]);
  const latestQuery = useRef<DashboardInsightPreviewResponse["query"] | undefined>(undefined);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [failure, setFailure] = useState<ChatFailure | null>(null);

  async function send(prompt: string, appendUser: boolean, productCopy?: ProductCopyRequest) {
    if (inFlight.current) return;
    inFlight.current = true;
    setFailure(null);

    if (appendUser) {
      setMessages((current) => [
        ...current,
        {
          role: "user",
          content: prompt,
        },
      ]);
    }

    setIsSending(true);

    try {
      const reply: ChatMessage = productCopy
        ? await sendChatMessage(prompt, undefined, productCopy)
        : ((await options.resolveMessage?.(prompt, completed.current)) ??
          (await (latestQuery.current
            ? sendChatMessage(prompt, undefined, undefined, completed.current, latestQuery.current)
            : completed.current.length
              ? sendChatMessage(prompt, undefined, undefined, completed.current)
              : sendChatMessage(prompt))));

      if (reply.insightPreview) latestQuery.current = reply.insightPreview.query;
      completed.current = boundedHistory([
        ...completed.current,
        { role: "user", content: prompt },
        { role: "assistant", content: reply.content },
      ]);
      setMessages((current) => [...current, reply]);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") {
        return;
      }

      const message = reason instanceof Error ? reason.message : "AI 服务暂时不可用，请稍后重试";

      const retryable =
        typeof reason === "object" &&
        reason !== null &&
        "retryable" in reason &&
        reason.retryable === true;

      setFailure({
        message,
        prompt,
        retryable,
        productCopy,
      });
    } finally {
      inFlight.current = false;
      setIsSending(false);
    }
  }

  async function submit(content = input, productCopy?: ProductCopyRequest) {
    const prompt = content.trim();

    if (!prompt || inFlight.current) {
      return;
    }

    setInput("");
    await send(prompt, true, productCopy);
  }

  async function retry() {
    if (!failure?.retryable || isSending) {
      return;
    }

    await send(failure.prompt, false, failure.productCopy);
  }

  return {
    messages,
    input,
    setInput,
    isSending,
    error: failure?.message ?? null,
    retryable: failure?.retryable ?? false,
    submit,
    retry,
  };
}

function boundedHistory(messages: ChatMessage[]): ChatMessage[] {
  const history = messages.slice(-12);
  while (history.reduce((size, message) => size + message.content.length, 0) > 24000) {
    history.splice(0, 2);
  }
  return history;
}
