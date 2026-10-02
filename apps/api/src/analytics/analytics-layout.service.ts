import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  AnalyticsLayoutReadResponseSchema,
  AnalyticsLayoutSaveRequestSchema,
  AnalyticsLayoutSchema,
  DEFAULT_ANALYTICS_LAYOUT,
  type AnalyticsLayoutReadResponse,
} from "@shopmate/contracts";

import type { AuthContext } from "../auth/contracts/index.js";
import {
  ANALYTICS_LAYOUT_REPOSITORY,
  type AnalyticsLayoutRecord,
  type AnalyticsLayoutRepository,
} from "./analytics-layout.repository.js";

@Injectable()
export class AnalyticsLayoutService {
  private readonly logger = new Logger(AnalyticsLayoutService.name);

  constructor(
    @Inject(ANALYTICS_LAYOUT_REPOSITORY) private readonly repository: AnalyticsLayoutRepository,
  ) {}

  async get(context: AuthContext): Promise<AnalyticsLayoutReadResponse> {
    try {
      const record = await this.repository.find(context);
      if (!record) return { layout: DEFAULT_ANALYTICS_LAYOUT, revision: 0, updatedAt: null };
      return this.toResponse(record);
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  async save(context: AuthContext, rawBody: unknown): Promise<AnalyticsLayoutReadResponse> {
    const request = AnalyticsLayoutSaveRequestSchema.safeParse(rawBody);
    if (!request.success) throwInvalidLayout();
    try {
      const result = await this.repository.save(
        context,
        request.data.layout,
        request.data.expectedRevision,
      );
      if (result.kind === "conflict") throwVersionConflict();
      return this.toResponse(result.record);
    } catch (error: unknown) {
      this.rethrow(error);
    }
  }

  /** 存量记录无法解析（如未来版本回滚）时回到默认布局，但保留 revision，下次保存仍能覆盖。 */
  private toResponse(record: AnalyticsLayoutRecord): AnalyticsLayoutReadResponse {
    const parsed = AnalyticsLayoutSchema.safeParse(record.layout);
    if (!parsed.success) this.logger.warn("已保存的经营分析布局无法解析，改用默认布局");
    return AnalyticsLayoutReadResponseSchema.parse({
      layout: parsed.success ? parsed.data : DEFAULT_ANALYTICS_LAYOUT,
      revision: record.revision,
      updatedAt: record.updatedAt.toISOString(),
    });
  }

  private rethrow(error: unknown): never {
    if (error instanceof BadRequestException || error instanceof ConflictException) throw error;
    this.logger.error("经营分析布局读写失败", error instanceof Error ? error.stack : String(error));
    throw new ServiceUnavailableException({
      statusCode: 503,
      code: "ANALYTICS_LAYOUT_SERVICE_UNAVAILABLE",
      message: "布局服务暂时不可用，请稍后重试",
      retryable: true,
    });
  }
}

function throwInvalidLayout(): never {
  throw new BadRequestException({
    statusCode: 400,
    code: "INVALID_ANALYTICS_LAYOUT",
    message: "布局格式无效",
    retryable: false,
  });
}

function throwVersionConflict(): never {
  throw new ConflictException({
    statusCode: 409,
    code: "ANALYTICS_LAYOUT_VERSION_CONFLICT",
    message: "布局已在其他设备更新，请刷新后重试",
    retryable: true,
  });
}
