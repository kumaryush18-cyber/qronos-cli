export const DEFAULT_BASE_URL = "https://api.qronos.me";

export function resolveBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.QRONOS_BASE_URL || env.QRONOS_BASE_URL || DEFAULT_BASE_URL;
}
