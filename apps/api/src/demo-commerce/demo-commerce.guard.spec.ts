import { HttpException } from "@nestjs/common";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host.js";
import { describe, expect, it } from "vitest";
import { createAuthContext, type AuthContext } from "../auth/contracts/index.js";
import { DemoCommerceGuard } from "./demo-commerce.guard.js";
import type { DemoCommerceEnvironment } from "./demo-commerce.environment.js";

interface RequestFixture {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  auth?: AuthContext;
  query?: unknown;
  body?: unknown;
}

const origin = "https://demo.example.com";
const enabled: DemoCommerceEnvironment = { enabled: true, origin };
const auth = createAuthContext({ userId: "user-a", merchantId: "merchant-a", permissions: [] });

function request(patch: Partial<RequestFixture> = {}): RequestFixture {
  return { method: "GET", headers: {}, rawHeaders: [], auth, ...patch };
}

function activate(input: RequestFixture, env = enabled): boolean {
  return new DemoCommerceGuard(env).canActivate(new ExecutionContextHost([input]));
}

function expectError(input: RequestFixture, status: number, code: string, env = enabled): void {
  try {
    activate(input, env);
    expect.fail("Expected a sanitized HTTP rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    if (!(error instanceof HttpException)) throw error;
    expect(error.getStatus()).toBe(status);
    expect(error.getResponse()).toMatchObject({ statusCode: status, code });
    expect(JSON.stringify(error.getResponse())).not.toContain("attacker");
  }
}

function post(patch: Partial<RequestFixture> = {}): RequestFixture {
  return request({ method: "POST", headers: { origin }, rawHeaders: ["Origin", origin], ...patch });
}

describe("DemoCommerceGuard", () => {
  it("requires authenticated context before validating controls", () => {
    expectError(request({ auth: undefined }), 401, "UNAUTHENTICATED");
  });

  it("uniformly hides disabled demo controls", () => {
    expectError(post(), 404, "RESOURCE_NOT_FOUND", { enabled: false, origin: null });
  });

  it.each(["GET", "HEAD"])("allows authenticated %s without Origin", (method) => {
    expect(activate(request({ method }))).toBe(true);
  });

  it("accepts a single exact Origin and defers POST body validation", () => {
    expect(activate(post({ body: { settings: {}, role: "attacker" } }))).toBe(true);
  });

  it.each([{ workspaceId: "attacker" }, ["attacker"], "attacker", 1, true])(
    "rejects nonempty query %o",
    (query) => {
      expectError(request({ query }), 400, "INVALID_DEMO_REQUEST");
    },
  );

  it.each(["GET", "HEAD"])("rejects nonempty %s body", (method) => {
    expectError(request({ method, body: { merchantId: "attacker" } }), 400, "INVALID_DEMO_REQUEST");
  });

  it.each([undefined, null, {}, [], ""])("accepts an empty read body %o", (body) => {
    expect(activate(request({ body, query: {} }))).toBe(true);
  });

  it.each(["PATCH", "DELETE", "PUT", "OPTIONS", "get", ""])("rejects method %s", (method) => {
    expectError(request({ method }), 400, "INVALID_DEMO_REQUEST");
  });

  it.each([
    post({ headers: {}, rawHeaders: [] }),
    post({ headers: { origin: "https://attacker.example.com" } }),
    post({ headers: { origin: `${origin}/` } }),
    post({ headers: { origin: [origin] } }),
    post({ rawHeaders: ["Origin", origin, "oRiGiN", origin] }),
    post({ rawHeaders: [] }),
    post({ headers: { origin, "sec-fetch-site": "cross-site" } }),
    post({ headers: { host: "demo.example.com", origin: "https://attacker.example.com" } }),
    post({ headers: { host: "demo.example.com" }, rawHeaders: ["Host", "demo.example.com"] }),
  ])("rejects invalid mutation provenance %o", (input) => {
    expectError(input, 403, "INVALID_DEMO_ORIGIN");
  });

  it("counts only raw header names when detecting duplicate Origin", () => {
    expect(activate(post({ rawHeaders: ["X-Example", "Origin", "Origin", origin] }))).toBe(true);
  });

  it.each(["same-origin", "same-site", "none"])(
    "permits valid Origin with fetch site %s",
    (site) => {
      expect(activate(post({ headers: { origin, "sec-fetch-site": site } }))).toBe(true);
    },
  );
});
