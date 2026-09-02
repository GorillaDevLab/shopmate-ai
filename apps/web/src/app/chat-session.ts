"use client";

import type { ProductCopyOutput } from "@shopmate/contracts";
import { useState } from "react";

import { sendChatMessage } from "./chat-api";

export type ChatMessage = {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly productCopy?: ProductCopyOutput;
};

type ChatFailure = {
  readonly message: string;
  readonly prompt: string;
};

export function useChatSession() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [failure, setFailure] = useState<ChatFailure | null>(null);

  async function send(prompt: string, appendUser: boolean) {
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
      const reply = await sendChatMessage(prompt);

      setMessages((current) => [...current, reply]);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") {
        return;
      }

      const message = reason instanceof Error ? reason.message : "AI 服务暂时不可用，请稍后重试";

      setFailure({
        message,
        prompt,
      });
    } finally {
      setIsSending(false);
    }
  }

  async function submit(content = input) {
    const prompt = content.trim();

    if (!prompt || isSending) {
      return;
    }

    setInput("");
    await send(prompt, true);
  }

  async function retry() {
    if (!failure || isSending) {
      return;
    }

    await send(failure.prompt, false);
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
