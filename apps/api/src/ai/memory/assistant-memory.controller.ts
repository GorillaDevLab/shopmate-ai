import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Put,
  ServiceUnavailableException,
} from "@nestjs/common";

import { MerchantContext } from "../../auth/access/merchant-context.decorator.js";
import type { AuthContext } from "../../auth/contracts/index.js";
import { AssistantMemoryService, AssistantWorkspaceService } from "./assistant-memory.service.js";

const logger = new Logger("AssistantStorage");

/** 已知错误原样返回；数据库等意外错误记录日志并统一为 503。 */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: unknown) {
    if (error instanceof HttpException) throw error;
    logger.error("助手存储读写失败", error instanceof Error ? error.stack : String(error));
    throw new ServiceUnavailableException({ code: "ASSISTANT_STORAGE_UNAVAILABLE" });
  }
}

@Controller({ path: "ai/memories", version: "1" })
export class AssistantMemoryController {
  constructor(private readonly memories: AssistantMemoryService) {}

  @Get()
  list(@MerchantContext() context: AuthContext) {
    return guarded(() => this.memories.list(context));
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@MerchantContext() context: AuthContext, @Param("id") id: string) {
    await guarded(() => this.memories.delete(context, id.slice(0, 64)));
  }

  @Delete()
  @HttpCode(204)
  async clear(@MerchantContext() context: AuthContext) {
    await guarded(() => this.memories.clear(context));
  }
}

@Controller({ path: "ai/workspace", version: "1" })
export class AssistantWorkspaceController {
  constructor(private readonly workspaces: AssistantWorkspaceService) {}

  @Get()
  get(@MerchantContext() context: AuthContext) {
    return guarded(() => this.workspaces.get(context));
  }

  @Put()
  save(@MerchantContext() context: AuthContext, @Body() body: unknown) {
    return guarded(() => this.workspaces.save(context, body));
  }

  @Delete()
  @HttpCode(204)
  async clear(@MerchantContext() context: AuthContext) {
    await guarded(() => this.workspaces.delete(context));
  }
}
