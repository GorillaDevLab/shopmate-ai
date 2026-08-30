import { describe, expect, it } from "vitest";

import { AuthPermission, createAuthContext } from "../contracts/index.js";
import { signDemoSession, verifyDemoSession } from "./demo-session.js";

const secret = "test-session-secret-with-at-least-32-characters";
const context = createAuthContext({
  userId: "demo-user",
  merchantId: "demo-merchant",
  permissions: [AuthPermission.ProductsRead],
});

describe("Demo 会话", () => {
  it("签发可验证且带过期时间的最小会话", () => {
    const signed = signDemoSession(context, secret, 3_600, 1_000_000);
    const payload = verifyDemoSession(signed.token, secret, 1_000_000);

    expect(payload).toEqual({ context, issuedAt: 1_000, expiresAt: 4_600 });
    expect(signed.expiresAt).toBe("1970-01-01T01:16:40.000Z");
  });

  it("拒绝被篡改的会话", () => {
    const signed = signDemoSession(context, secret, 3_600, 1_000_000);
    expect(verifyDemoSession(`${signed.token}x`, secret, 1_000_000)).toBeNull();
  });

  it("拒绝已过期的会话", () => {
    const signed = signDemoSession(context, secret, 60, 1_000_000);
    expect(verifyDemoSession(signed.token, secret, 1_060_000)).toBeNull();
  });
});
