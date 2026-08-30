import { createHmac, timingSafeEqual } from "node:crypto";

import { AuthPermission, type AuthContext } from "../contracts/index.js";

export interface DemoSessionPayload {
  readonly context: AuthContext;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface SignedDemoSession {
  readonly token: string;
  readonly expiresAt: string;
}

export function signDemoSession(
  context: AuthContext,
  secret: string,
  ttlSeconds: number,
  nowMilliseconds = Date.now(),
): SignedDemoSession {
  const issuedAt = Math.floor(nowMilliseconds / 1_000);
  const payload: DemoSessionPayload = { context, issuedAt, expiresAt: issuedAt + ttlSeconds };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    token: `${encoded}.${sign(encoded, secret)}`,
    expiresAt: new Date(payload.expiresAt * 1_000).toISOString(),
  };
}

export function verifyDemoSession(
  token: string,
  secret: string,
  nowMilliseconds = Date.now(),
): DemoSessionPayload | null {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra || !safeEqual(signature, sign(encoded, secret))) return null;

  try {
    const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!isDemoSessionPayload(payload)) return null;
    return payload.expiresAt <= Math.floor(nowMilliseconds / 1_000) ? null : payload;
  } catch {
    return null;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function isDemoSessionPayload(value: unknown): value is DemoSessionPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    Number.isInteger(candidate.issuedAt) &&
    Number.isInteger(candidate.expiresAt) &&
    isAuthContext(candidate.context)
  );
}

function isAuthContext(value: unknown): value is AuthContext {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const permissions = new Set<string>(Object.values(AuthPermission));
  return (
    typeof candidate.userId === "string" &&
    typeof candidate.merchantId === "string" &&
    Array.isArray(candidate.permissions) &&
    candidate.permissions.every((permission) => permissions.has(permission))
  );
}
