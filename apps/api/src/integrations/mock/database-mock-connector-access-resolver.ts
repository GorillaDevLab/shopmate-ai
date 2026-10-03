import type { ReadOptions } from "@shopmate/contracts";
import type { AuthContext } from "../../auth/contracts/index.js";
import type { DemoCommerceRepository } from "../../demo-commerce/demo-commerce.repository.js";
import { validateDemoRecord } from "../../demo-commerce/demo-commerce.record.js";
import type { MockConnectorAccessResolver } from "./mock-connector-factory.js";
import { MockConnectorError } from "./mock-call.js";
import { PersistentMockClock } from "./persistent-mock-clock.js";

export class DatabaseMockConnectorAccessResolver implements MockConnectorAccessResolver {
  constructor(
    private readonly repository: DemoCommerceRepository,
    private readonly clock: PersistentMockClock,
  ) {}
  async resolve(
    identity: AuthContext,
    storeId: string,
    options: ReadOptions,
  ): Promise<unknown | null> {
    checkCall(options);
    const actor = { userId: identity.userId, merchantId: identity.merchantId };
    const input = await this.find(actor, storeId);
    checkCall(options);
    if (!input || input.environmentMarker !== "DEMO" || input.demoTenant !== true) return null;
    const { record, config, context } = validateRecord(input, actor, storeId);
    if (record.status === "DISCONNECTED") return null;
    checkCall(options);
    this.clock.refresh({
      now: record.clockNow.toISOString(),
      revision: record.clockRevision,
      generation: record.generation,
    });
    return {
      context,
      config,
      generation: record.generation,
      environmentMarker: "demo",
      demoTenant: true,
    };
  }
  private async find(actor: { userId: string; merchantId: string }, storeId: string) {
    try {
      return await this.repository.findDemoSession(actor, storeId);
    } catch {
      throw new MockConnectorError("TEMPORARY");
    }
  }
}
function checkCall(options: ReadOptions): void {
  if (options.signal?.aborted) throw new MockConnectorError("ABORTED");
  if (Date.now() >= Date.parse(options.deadlineAt)) throw new MockConnectorError("TIMEOUT");
}
function validateRecord(
  input: unknown,
  actor: { userId: string; merchantId: string },
  storeId: string,
) {
  try {
    return validateDemoRecord(input, actor, storeId);
  } catch {
    throw new MockConnectorError("INVALID_RESPONSE");
  }
}
