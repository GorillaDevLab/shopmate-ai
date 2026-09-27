import { redirect } from "next/navigation";

// 经营分析已成为首页；保留旧地址的书签与链接。
export default function AnalyticsPage() {
  redirect("/");
}
