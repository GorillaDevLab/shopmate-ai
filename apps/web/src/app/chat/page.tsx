"use client";
import { AssistantWorkspace } from "../assistant/workspace";
import { AppearanceProvider } from "../appearance-provider";
import { AppearanceControls } from "../appearance-controls";
import { AppShell } from "../app-shell";
import { MemoryPanel } from "../assistant/memory-panel";
export default function ChatPage() {
  return (
    <AppearanceProvider>
      <AppShell active="assistant" fill>
        <div className="assistant-page">
          <header className="assistant-page-header">
            <h1 className="assistant-page-title">AI 助手</h1>
            <div className="assistant-page-actions">
              <MemoryPanel />
              <AppearanceControls />
            </div>
          </header>
          <AssistantWorkspace />
        </div>
      </AppShell>
    </AppearanceProvider>
  );
}
