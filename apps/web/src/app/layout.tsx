import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./appearance.css";
import { THEME_INIT_SCRIPT } from "./theme";
import { APPEARANCE_INIT_SCRIPT } from "./appearance-model";
import { isMobileDebugEnabled, mobileDebugScript } from "./mobile-debug-script";

export const metadata: Metadata = {
  title: "ShopMate AI｜智能经营助手",
  description: "面向电商商家的中文经营看板，集中查看销售、商品与库存信息。",
};

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN" data-theme="purple" data-appearance="calm" suppressHydrationWarning>
      <head>
        {isMobileDebugEnabled(process.env.NEXT_PUBLIC_ENABLE_DEBUG_REPORT) && (
          <script dangerouslySetInnerHTML={{ __html: mobileDebugScript() }} />
        )}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
