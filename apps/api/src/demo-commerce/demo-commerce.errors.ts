import { HttpException } from "@nestjs/common";
export function demoError(statusCode: number): HttpException {
  const code = (
    {
      400: "INVALID_DEMO_REQUEST",
      403: "DEMO_MANAGEMENT_DENIED",
      404: "RESOURCE_NOT_FOUND",
      409: "DEMO_CONFLICT",
      503: "DEMO_UNAVAILABLE",
    } as Record<number, string>
  )[statusCode];
  return new HttpException({ statusCode, code, message: "演示操作无法完成" }, statusCode);
}
export async function databaseCall<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch {
    throw demoError(503);
  }
}
export function validateResponse<T>(action: () => T): T {
  try {
    return action();
  } catch {
    throw demoError(503);
  }
}
