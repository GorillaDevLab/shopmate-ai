"use client";
import { AssistantWorkspace } from "../assistant/workspace";
import { AppearanceProvider } from "../appearance-provider";
import { AppearanceControls } from "../appearance-controls";
import { ThemeSettings } from "../theme-settings";
import { LogoutButton } from "../logout-button";
import Link from "next/link";
export default function ChatPage() {
  return (
    <AppearanceProvider>
      <main className="assistant-page">
        <header className="assistant-page-header">
          <Link href="/" className="assistant-brand">
            <span>S</span>ShopMate AI
          </Link>
          <AppearanceControls />
          <div>
            <ThemeSettings />
            <LogoutButton />
          </div>
        </header>
        <AssistantWorkspace />
      </main>
    </AppearanceProvider>
  );
}
