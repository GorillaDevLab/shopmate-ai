"use client";

import type { ProductCopyOutput, ProductCopyRequest } from "@shopmate/contracts";
import { useRef, useState } from "react";

import { sendChatMessage } from "./chat-api";

export type ChatMessage = {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly productCopy?: ProductCopyOutput;
};

type ChatFailure = {
  readonly message: string;
  readonly prompt: string;
  readonly productCopy?: ProductCopyRequest;
};

type ChatSessionOptions = {
  readonly resolveMessage?: (prompt: string) => Promise<ChatMessage | undefined>;
};

export function useChatSession(options: ChatSessionOptions = {}) {
  const inFlight = useRef(false);
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
      const reply = productCopy
        ? await sendChatMessage(prompt, undefined, productCopy)
        : ((await options.resolveMessage?.(prompt)) ?? (await sendChatMessage(prompt)));

      setMessages((current) => [...current, reply]);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") {
        return;
      }

      const message = reason instanceof Error ? reason.message : "AI 服务暂时不可用，请稍后重试";

      setFailure({
        message,
        prompt,
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
    if (!failure || isSending) {
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
    submit,
    retry,
  };
}
