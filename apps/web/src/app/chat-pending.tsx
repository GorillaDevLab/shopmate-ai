"use client";

import { useEffect, useState } from "react";

export function ChatPending() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 15000);
    return () => clearTimeout(timer);
  }, []);
  // The synchronous API does not expose stages; never pretend to know its progress.
  return (
    <div className="ai-assistant-thinking" role="status" aria-live="polite">
      <span>正在整理经营数据…</span>
      <span className="chat-pending-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {slow && <p>仍在处理中，请勿重复提交。当前请求不会自动重试。</p>}
    </div>
  );
}
