const DEFAULT_API_PORT = 3001;

export function resolvePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_API_PORT;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT 必须是 1 到 65535 之间的整数");
  }

  return port;
}
