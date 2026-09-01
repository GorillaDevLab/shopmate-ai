import { describe, expect, it } from "vitest";

import { AuthPermission } from "../../auth/contracts/auth-context.js";

import {
  InventoryAlertUpdateError,
  InventoryAlertUpdateService,
} from "./inventory-alert-update.tool.js";

import type {
  ConfirmInventoryAlertThresholdInput,
  ConfirmInventoryAlertThresholdResult,
  InventoryAlertUpdateRepository,
} from "./inventory-alert-update.repository.js";

const FIXED_TOKEN = ["inventory", "confirmation", "boundary", "primary"].join("-");

const UNKNOWN_TOKEN = ["inventory", "confirmation", "boundary", "unknown"].join("-");

describe("I3 库存预警确认权限与并发边界", () => {
  it("Preview 和取消路径始终不修改库存预警值且重复取消幂等", async () => {
    const { repository, service } = createHarness();

    const preview = await createPreview(service);

    expect(preview.status).toBe("PENDING");
    expect(repository.currentAlertThreshold).toBe(10);
    expect(repository.writeCount).toBe(0);

    const first = service.cancel(preview.confirmationToken, writeContext());

    const second = service.cancel(preview.confirmationToken, writeContext());

    expect(first.status).toBe("CANCELLED");
    expect(second).toEqual(first);

    expect(repository.currentAlertThreshold).toBe(10);
    expect(repository.writeCount).toBe(0);

    const confirmAfterCancel = await service.confirm(preview.confirmationToken, writeContext());

    expect(confirmAfterCancel).toEqual(first);
    expect(repository.writeCount).toBe(0);
  });

  it("过期确认不会写入且重复请求返回同一过期结果", async () => {
    const { clock, repository, service } = createHarness();

    const preview = await createPreview(service);

    clock.now = new Date("2026-09-01T09:05:00.000Z");

    const first = await service.confirm(preview.confirmationToken, writeContext());

    const second = await service.confirm(preview.confirmationToken, writeContext());

    expect(first.status).toBe("EXPIRED");
    expect(second).toEqual(first);

    expect(repository.currentAlertThreshold).toBe(10);
    expect(repository.writeCount).toBe(0);
  });

  it("成功确认重复调用只写入一次", async () => {
    const { repository, service } = createHarness();

    const preview = await createPreview(service);

    const first = await service.confirm(preview.confirmationToken, writeContext());

    const second = await service.confirm(preview.confirmationToken, writeContext());

    expect(first).toEqual({
      status: "CONFIRMED",
      confirmationId: "confirmation-boundary-001",
      skuId: "sku-001",
      previousAlertThreshold: 10,
      newAlertThreshold: 20,
      confirmedAt: "2026-09-01T09:00:00.000Z",
    });

    expect(second).toEqual(first);

    expect(repository.currentAlertThreshold).toBe(20);
    expect(repository.writeCount).toBe(1);
    expect(repository.confirmAttemptCount).toBe(1);
  });

  it("跨用户、跨 Merchant 与未知令牌返回相同安全响应", async () => {
    const { repository, service } = createHarness();

    const preview = await createPreview(service);

    const unknownError = await captureError(service.confirm(UNKNOWN_TOKEN, writeContext()));

    const wrongUserError = await captureError(
      service.confirm(preview.confirmationToken, writeContext("user-other", "merchant-001")),
    );

    const wrongMerchantError = await captureError(
      service.confirm(preview.confirmationToken, writeContext("user-001", "merchant-other")),
    );

    expect(unknownError.toJSON()).toEqual({
      code: "CONFIRMATION_NOT_FOUND",
      message: "确认令牌不存在或已经失效。",
    });

    expect(wrongUserError.toJSON()).toEqual(unknownError.toJSON());

    expect(wrongMerchantError.toJSON()).toEqual(unknownError.toJSON());

    const serialized = JSON.stringify(wrongMerchantError);

    expect(serialized).not.toContain("sku-001");
    expect(serialized).not.toContain("merchant-001");
    expect(serialized).not.toContain(FIXED_TOKEN);

    expect(repository.writeCount).toBe(0);
  });

  it("Preview 后当前阈值变化会返回冲突且不会覆盖新值", async () => {
    const { repository, service } = createHarness();

    const preview = await createPreview(service);

    repository.externalUpdate(15, "2026-09-01T09:00:30.000Z");

    const result = await service.confirm(preview.confirmationToken, writeContext());

    expect(result).toMatchObject({
      status: "CONFLICT",
      skuId: "sku-001",
      expectedAlertThreshold: 10,
      actualAlertThreshold: 15,
    });

    expect(repository.currentAlertThreshold).toBe(15);

    expect(repository.writeCount).toBe(0);
  });

  it("即使阈值相同但 updatedAt 已变化也不会覆盖", async () => {
    const { repository, service } = createHarness();

    const preview = await createPreview(service);

    repository.externalUpdate(10, "2026-09-01T09:00:30.000Z");

    const result = await service.confirm(preview.confirmationToken, writeContext());

    expect(result).toMatchObject({
      status: "CONFLICT",
      skuId: "sku-001",
      expectedAlertThreshold: 10,
      actualAlertThreshold: 10,
    });

    expect(repository.currentAlertThreshold).toBe(10);
    expect(repository.writeCount).toBe(0);
  });
});

class MutableInventoryAlertRepository implements InventoryAlertUpdateRepository {
  private alertThreshold = 10;

  private updatedAt = "2026-09-01T08:00:00.000Z";

  readonly merchantId = "merchant-001";

  readonly skuId = "sku-001";

  confirmAttemptCount = 0;

  writeCount = 0;

  get currentAlertThreshold(): number {
    return this.alertThreshold;
  }

  externalUpdate(alertThreshold: number, updatedAt: string): void {
    this.alertThreshold = alertThreshold;
    this.updatedAt = updatedAt;
  }

  async findSkuSnapshot(merchantId: string, skuId: string) {
    if (merchantId !== this.merchantId || skuId !== this.skuId) {
      return null;
    }

    return {
      skuId: this.skuId,
      alertThreshold: this.alertThreshold,
      updatedAt: this.updatedAt,
    };
  }

  async confirmAlertThreshold(
    input: ConfirmInventoryAlertThresholdInput,
  ): Promise<ConfirmInventoryAlertThresholdResult> {
    this.confirmAttemptCount += 1;

    if (input.merchantId !== this.merchantId || input.skuId !== this.skuId) {
      return {
        kind: "NOT_FOUND",
      };
    }

    if (
      input.expectedAlertThreshold !== this.alertThreshold ||
      input.expectedSkuUpdatedAt !== this.updatedAt
    ) {
      return {
        kind: "CONFLICT",
        skuId: this.skuId,
        actualAlertThreshold: this.alertThreshold,
        actualSkuUpdatedAt: this.updatedAt,
      };
    }

    const previousAlertThreshold = this.alertThreshold;

    this.alertThreshold = input.targetAlertThreshold;

    this.updatedAt = "2026-09-01T09:00:30.000Z";

    this.writeCount += 1;

    return {
      kind: "CONFIRMED",
      skuId: this.skuId,
      previousAlertThreshold,
      newAlertThreshold: this.alertThreshold,
    };
  }
}

function createHarness() {
  const repository = new MutableInventoryAlertRepository();

  const clock = {
    now: new Date("2026-09-01T09:00:00.000Z"),
  };

  const service = new InventoryAlertUpdateService(repository, undefined, {
    now: () => new Date(clock.now.getTime()),

    createConfirmationId: () => "confirmation-boundary-001",

    createConfirmationToken: () => FIXED_TOKEN,
  });

  return {
    clock,
    repository,
    service,
  };
}

async function createPreview(service: InventoryAlertUpdateService) {
  return service.preview(
    {
      action: "PREVIEW",
      skuId: "sku-001",
      targetAlertThreshold: 20,
    },
    writeContext(),
  );
}

function writeContext(userId = "user-001", merchantId = "merchant-001") {
  return {
    userId,
    merchantId,
    permissions: [AuthPermission.InventoryWrite],
  } as const;
}

async function captureError(operation: Promise<unknown>): Promise<InventoryAlertUpdateError> {
  try {
    await operation;
  } catch (error: unknown) {
    if (error instanceof InventoryAlertUpdateError) {
      return error;
    }

    throw error;
  }

  throw new Error("预期库存预警确认操作失败，但实际成功。");
}
