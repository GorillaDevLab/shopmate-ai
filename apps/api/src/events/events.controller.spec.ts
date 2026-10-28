import "reflect-metadata";
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createEventFingerprint, EventRecordSchema, type TenantContext } from "@shopmate/contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { configureApp } from "../app.config.js";
import { DemoAuthModule } from "../auth/demo-auth.module.js";
import { DEMO_AUTH_CONFIG } from "../auth/demo-auth.config.js";
import { signDemoSession } from "../auth/session/demo-session.js";
import { DEMO_SESSION_COOKIE_NAME } from "../auth/session/demo-session-cookie.js";
import { TenantScopeService } from "../tenant/tenant-scope.service.js";
import { TENANT_MEMBERSHIP_REPOSITORY } from "../tenant/tenant-membership.repository.js";
import { EventsController } from "./events.controller.js";
import {
  EVENT_QUERY_PORT,
  EVENT_STORE_OWNERSHIP_RESOLVER,
  EventQueryService,
} from "./event-query.service.js";

const key = randomBytes(48).toString("hex");
const binding = {
  organizationId: "org-a",
  workspaceId: "workspace-a",
  storeId: "store-a",
  connectionId: "connection-a",
  externalStoreId: "external-a",
};
const instant = "2026-10-25T01:00:00Z";
const reference = {
  schemaVersion: 1,
  id: "evidence-a",
  version: "evidence-v2",
  hash: "hash-a-v2",
  binding,
  eventType: "SYNC_FAILURE",
  entity: { kind: "CONNECTION", connectionId: binding.connectionId },
  definitionVersion: "metrics-v1",
  baselineVersion: null,
} as const;
const event = EventRecordSchema.parse({
  schemaVersion: 1,
  id: "event-a",
  binding,
  eventType: "SYNC_FAILURE",
  entity: reference.entity,
  fingerprint: createEventFingerprint(reference),
  severityFloor: "HIGH",
  rulePolicyVersion: "policy-v1",
  state: "OPEN",
  revision: 2,
  firstSeenAt: instant,
  lastSeenAt: instant,
  currentEvidence: reference,
});
const member = {
  userId: "user-a",
  merchantId: "merchant-a",
  organizationId: "org-a",
  workspaceId: "workspace-a",
  role: "VIEWER",
};
const membership = vi.fn();
const ownership = vi.fn();
const list = vi.fn();
const detail = vi.fn();
const evidence = vi.fn();
const history = vi.fn();
const path = "/api/v1/stores/store-a/events";
let app: INestApplication;

function cookie(userId = "user-a") {
  return `${DEMO_SESSION_COOKIE_NAME}=${signDemoSession({ userId, merchantId: "merchant-a", permissions: [] }, key, 3600).token}`;
}
function success<T>(value: T) {
  return { ok: true as const, value };
}
function get(suffix = "") {
  return request(app.getHttpServer())
    .get(path + suffix)
    .set("Cookie", cookie());
}
async function createApp() {
  const module = await Test.createTestingModule({
    imports: [DemoAuthModule],
    controllers: [EventsController],
    providers: [
      EventQueryService,
      TenantScopeService,
      { provide: TENANT_MEMBERSHIP_REPOSITORY, useValue: { resolve: membership } },
      { provide: EVENT_STORE_OWNERSHIP_RESOLVER, useValue: { resolve: ownership } },
      { provide: EVENT_QUERY_PORT, useValue: { list, detail, evidence, history } },
    ],
  })
    .overrideProvider(DEMO_AUTH_CONFIG)
    .useValue({ sessionSecret: key })
    .compile();
  const instance = module.createNestApplication();
  configureApp(instance);
  await instance.init();
  return instance;
}
beforeAll(async () => {
  app = await createApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  membership.mockImplementation(async (user: string, merchant: string, workspace?: string) =>
    user === member.userId &&
    merchant === member.merchantId &&
    (!workspace || workspace === member.workspaceId)
      ? member
      : null,
  );
  ownership.mockImplementation(async (_actor: TenantContext, storeId: string) =>
    storeId === binding.storeId ? binding : null,
  );
  list.mockResolvedValue(success({ items: [event], nextCursor: null }));
  detail.mockResolvedValue(success(event));
});

it("requires the existing signed session guard", async () => {
  await request(app.getHttpServer()).get(path).expect(401);
  expect(membership).not.toHaveBeenCalled();
});
it("returns an explicit empty page for a valid query", async () => {
  list.mockResolvedValue(success({ items: [], nextCursor: null }));
  const response = await get().expect(200);
  expect(response.body).toEqual({ status: "EMPTY", items: [], nextCursor: null });
});
it("uses fresh membership and current server-owned store binding", async () => {
  const response = await get().expect(200);
  expect(response.body.items).toEqual([event]);
  expect(list).toHaveBeenCalledWith(
    expect.objectContaining({
      actor: expect.objectContaining({
        userId: member.userId,
        permissions: expect.arrayContaining(["tenant:read"]),
      }),
      binding,
      eventTypes: [],
      states: [],
      entity: null,
      cursor: null,
      limit: 20,
    }),
  );
  membership.mockResolvedValue(null);
  await get().expect(404);
  expect(list).toHaveBeenCalledTimes(1);
});
it("requires all existing business evidence read permissions before ownership", async () => {
  vi.spyOn(app.get(TenantScopeService), "resolve").mockResolvedValue({
    ...member,
    role: "VIEWER",
    permissions: ["tenant:read"],
  });
  await get().expect(403);
  expect(ownership).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});
it("returns 404 for foreign stores even for critical severity", async () => {
  ownership.mockResolvedValue({ ...binding, storeId: "foreign-store" });
  await get().expect(404);
  expect(list).not.toHaveBeenCalled();
});
it.each([
  { type: "unknown" },
  { state: "IGNORE" },
  { limit: "101" },
  { limit: "01" },
  { limit: "1e2" },
  { cursor: "" },
  { severity: "CRITICAL" },
  { storeId: "foreign" },
  { type: ["SYNC_FAILURE", "ROAS_DROP"] },
  { state: ["OPEN", "OPEN"] },
])("rejects non-whitelisted or malformed filters %j before membership", async (query) => {
  await get().query(query).expect(400);
  expect(membership).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});

it("passes stable opaque cursors and strict type/state filters without reordering", async () => {
  list.mockResolvedValueOnce(success({ items: [event], nextCursor: "stable-next" }));
  const first = await get().query({ type: "SYNC_FAILURE", state: "OPEN", limit: "1" }).expect(200);
  expect(first.body.nextCursor).toBe("stable-next");
  list.mockResolvedValueOnce(success({ items: [], nextCursor: null }));
  const second = await get()
    .query({ type: "SYNC_FAILURE", state: "OPEN", limit: "1", cursor: "stable-next" })
    .expect(200);
  expect(second.body.status).toBe("EMPTY");
  expect(list).toHaveBeenLastCalledWith(
    expect.objectContaining({
      cursor: "stable-next",
      limit: 1,
      eventTypes: ["SYNC_FAILURE"],
      states: ["OPEN"],
    }),
  );
});
it.each([
  { items: [event, event], nextCursor: null },
  { items: [], nextCursor: "cursor" },
  { items: [{ ...event, revision: 0 }], nextCursor: null },
  { items: [event], nextCursor: 123 },
  { items: [{ ...event, binding: { ...binding, storeId: "foreign" } }], nextCursor: null },
  { items: [event], nextCursor: null, privateData: "secret" },
])("rejects malformed adapter pages without exposing private data %j", async (page) => {
  list.mockResolvedValue(success(page));
  const response = await get().expect(503);
  expect(response.body.status).toBe("UNAVAILABLE");
  expect(JSON.stringify(response.body)).not.toContain("secret");
});
it("rejects valid adapter records that disagree with filters or full connection binding", async () => {
  await get().query({ state: "RESOLVED" }).expect(503);
  await get().query({ type: "ROAS_DROP" }).expect(503);
  ownership.mockResolvedValue({ ...binding, externalStoreId: "changed-binding" });
  await get().expect(503);
});
it.each([
  "INVALID_INPUT",
  "FORBIDDEN",
  "NOT_FOUND",
  "SCOPE_MISMATCH",
  "SOURCE_UNAVAILABLE",
] as const)("maps typed adapter failure %s and removes evidence IDs", async (code) => {
  list.mockResolvedValue({ ok: false, error: { code, evidenceIds: ["private-evidence"] } });
  const status = {
    INVALID_INPUT: 400,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    SCOPE_MISMATCH: 404,
    SOURCE_UNAVAILABLE: 503,
  }[code];
  const response = await get().expect(status);
  expect(JSON.stringify(response.body)).not.toContain("private-evidence");
});
it("masks thrown adapter and ownership errors", async () => {
  list.mockRejectedValue(new Error("private database credentials"));
  const response = await get().expect(503);
  expect(JSON.stringify(response.body)).not.toContain("private");
  ownership.mockRejectedValue(new Error("private connection"));
  await get().expect(503);
});
it("rejects repeated, malformed or conflicting workspace headers", async () => {
  await get()
    .set({ "X-Workspace-Id": ["workspace-a", "workspace-a"] })
    .expect(400);
  await get().set("X-Workspace-Id", "workspace-a,workspace-a").expect(400);
  await request(app.getHttpServer())
    .get("/api/v1/workspaces/workspace-a/stores/store-a/events")
    .set("Cookie", cookie())
    .set("X-Workspace-Id", "workspace-b")
    .expect(400);
  expect(membership).not.toHaveBeenCalled();
});
it("returns 404 for a valid foreign workspace and accepts matching path/header scope", async () => {
  await get().set("X-Workspace-Id", "workspace-b").expect(404);
  await request(app.getHttpServer())
    .get("/api/v1/workspaces/workspace-a/stores/store-a/events")
    .set("Cookie", cookie())
    .set("X-Workspace-Id", "workspace-a")
    .expect(200);
  expect(membership).toHaveBeenLastCalledWith("user-a", "merchant-a", "workspace-a");
});
it("rejects request bodies and missing direct-call authentication", async () => {
  await get().send({ state: "OPEN" }).expect(400);
  expect(membership).not.toHaveBeenCalled();
  await expect(
    app.get(EventQueryService).list({
      headers: {},
      rawHeaders: [],
      params: { storeId: "store-a" },
      query: {},
    }),
  ).rejects.toMatchObject({ status: 401 });
});
