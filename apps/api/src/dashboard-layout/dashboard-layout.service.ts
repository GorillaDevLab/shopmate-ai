import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  DashboardLayoutReadResponseSchema,
  DashboardLayoutSaveRequestSchema,
  DashboardLayoutSchema,
  DEFAULT_DASHBOARD_LAYOUT,
  type DashboardLayoutReadResponse,
} from "@shopmate/contracts";

import type { AuthContext } from "../auth/contracts/index.js";
import {
  DASHBOARD_LAYOUT_REPOSITORY,
  type DashboardLayoutRecord,
  type DashboardLayoutRepository,
} from "./dashboard-layout.repository.js";

@Injectable()
export class DashboardLayoutService {
  constructor(
    @Inject(DASHBOARD_LAYOUT_REPOSITORY) private readonly repository: DashboardLayoutRepository,
  ) {}

  async get(context: AuthContext): Promise<DashboardLayoutReadResponse> {
    try {
      const record = await this.repository.find(context);
      if (!record) {
        return { layout: DEFAULT_DASHBOARD_LAYOUT, revision: 0, updatedAt: null };
      }
      return toResponse(record);
    } catch (error: unknown) {
      throwLayoutServiceError(error);
    }
  }

  async save(context: AuthContext, rawBody: unknown): Promise<DashboardLayoutReadResponse> {
    const request = DashboardLayoutSaveRequestSchema.safeParse(rawBody);
    if (!request.success) throwInvalidLayout();

    try {
      const result = await this.repository.save(
        context,
        request.data.layout,
        request.data.expectedRevision,
      );
      if (result.kind === "conflict") throwVersionConflict();
      return toResponse(result.record);
    } catch (error: unknown) {
      throwLayoutServiceError(error);
    }
  }
}

function toResponse(record: DashboardLayoutRecord): DashboardLayoutReadResponse {
  const layout = DashboardLayoutSchema.parse(record.layout);
  return DashboardLayoutReadResponseSchema.parse({
    layout,
    revision: record.revision,
    updatedAt: record.updatedAt.toISOString(),
  });
}

function throwInvalidLayout(): never {
  throw new BadRequestException({
    statusCode: 400,
    code: "INVALID_DASHBOARD_LAYOUT",
    message: "看板布局格式无效",
    retryable: false,
  });
}

function throwVersionConflict(): never {
  throw new ConflictException({
    statusCode: 409,
    code: "DASHBOARD_LAYOUT_VERSION_CONFLICT",
    message: "看板布局已在其他设备更新，请刷新后重试",
    retryable: true,
  });
}

function throwLayoutServiceError(error: unknown): never {
  if (error instanceof BadRequestException || error instanceof ConflictException) throw error;
  throw new ServiceUnavailableException({
    statusCode: 503,
    code: "DASHBOARD_LAYOUT_SERVICE_UNAVAILABLE",
    message: "看板布局服务暂时不可用，请稍后重试",
    retryable: true,
  });
}
