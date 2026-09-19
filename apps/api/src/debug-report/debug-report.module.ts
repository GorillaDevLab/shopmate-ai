import {
  Body,
  Controller,
  HttpException,
  Injectable,
  Module,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  BadRequestException,
} from "@nestjs/common";
import { DebugReportSchema, sanitizeDebugData } from "@shopmate/contracts";
import { MerchantContext } from "../auth/access/merchant-context.decorator.js";
import type { AuthContext } from "../auth/contracts/index.js";

@Injectable()
export class DebugReportService {
  private readonly attempts = new Map<string, number[]>();

  async send(context: AuthContext, body: unknown) {
    if (process.env.ENABLE_DEBUG_REPORT !== "true") throw new NotFoundException();
    this.limit(context.userId);
    if (Buffer.byteLength(JSON.stringify(body) ?? "") > 64 * 1024)
      throw new HttpException("报告过大", 413);
    const parsed = DebugReportSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("报告格式无效");
    const key = process.env.DEBUG_REPORT_EMAIL_API_KEY;
    const from = process.env.DEBUG_REPORT_EMAIL_FROM;
    if (!key || !from || /[\r\n]/.test(from))
      throw new ServiceUnavailableException("邮件服务尚未配置");
    const report = sanitizeDebugData(parsed.data) as typeof parsed.data;
    const text = [
      "Mobile Debug Report",
      `Server UTC: ${new Date().toISOString()}`,
      `Device: ${report.device}`,
      `Description: ${report.description}`,
      "PAGE / DEVICE / APP",
      JSON.stringify(report.info, null, 2),
      ...report.logs.map((log) => `[${log.time}] ${log.type.toUpperCase()}\n${log.detail}`),
    ].join("\n\n");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        signal: abort.signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: ["1719379411@qq.com"],
          subject: `[Mobile Debug Report] ${report.device} - ${new Date().toISOString()}`,
          text,
        }),
      });
      if (!response.ok) throw new Error("delivery rejected");
      return { accepted: true };
    } catch {
      throw new ServiceUnavailableException("Failed to send debug report.");
    } finally {
      clearTimeout(timer);
    }
  }

  private limit(user: string) {
    const now = Date.now();
    for (const [key, times] of this.attempts)
      if (times.every((time) => now - time >= 60000)) this.attempts.delete(key);
    const recent = (this.attempts.get(user) ?? []).filter((time) => now - time < 60000);
    if (recent.length >= 2 || (!this.attempts.has(user) && this.attempts.size >= 1000))
      throw new HttpException("每分钟最多发送两次", 429);
    this.attempts.set(user, [...recent, now]);
  }
}

@Controller({ path: "debug-report", version: "1" })
export class DebugReportController {
  constructor(private readonly reports: DebugReportService) {}
  @Post()
  send(@MerchantContext() context: AuthContext, @Body() body: unknown) {
    return this.reports.send(context, body);
  }
}

@Module({ controllers: [DebugReportController], providers: [DebugReportService] })
export class DebugReportModule {}
