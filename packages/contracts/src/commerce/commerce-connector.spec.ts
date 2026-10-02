import { spawnSync } from "node:child_process";
import { expect, expectTypeOf, it } from "vitest";
import type {
  CommerceConnector,
  ConnectorOrder,
  ConnectorPage,
  ConnectorResult,
  InventoryQuery,
  ReadOptions,
  SetInventoryCommand,
  SyncPageQuery,
  VerificationResult,
  VerifyActionQuery,
  WriteReceipt,
} from "../index.js";

it("preserves typed read, write and independent verification boundaries", () => {
  expectTypeOf<CommerceConnector["listOrders"]>().toEqualTypeOf<
    (
      query: SyncPageQuery,
      options: ReadOptions,
    ) => Promise<ConnectorResult<ConnectorPage<ConnectorOrder>>>
  >();
  expectTypeOf<Parameters<CommerceConnector["getInventory"]>>().toEqualTypeOf<
    [query: InventoryQuery, options: ReadOptions]
  >();
  expectTypeOf<CommerceConnector["updateInventory"]>().toEqualTypeOf<
    (command: SetInventoryCommand, options: ReadOptions) => Promise<WriteReceipt>
  >();
  expectTypeOf<CommerceConnector["verifyAction"]>().toEqualTypeOf<
    (query: VerifyActionQuery, options: ReadOptions) => Promise<ConnectorResult<VerificationResult>>
  >();
});

it("publishes usable schemas and scoped parsers through the built package", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import {
      ConnectorStoreSchema, parseConnectorRead, parseConnectorPage,
      SetInventoryCommandSchema, VerificationResultSchema,
    } from "@shopmate/contracts";
    const store = {
      externalStoreId: "store-a", name: "演示店铺", category: "家居",
      currency: "CNY", timeZone: "Asia/Shanghai",
      source: { version: "v1", updatedAt: "2026-10-03T08:00:00Z",
        quality: { state: "COMPLETE", issues: [] } },
    };
    if (!parseConnectorRead(ConnectorStoreSchema, "store-a", store).ok)
      throw new Error("Public scoped parser failed");
    if (parseConnectorRead(ConnectorStoreSchema, "store-b", store).ok)
      throw new Error("Public scoped parser leaked foreign store");
    if (typeof parseConnectorPage !== "function" || !SetInventoryCommandSchema || !VerificationResultSchema)
      throw new Error("Commerce exports missing");
  `,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
