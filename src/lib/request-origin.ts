export function isSameOriginRequest(
  host: string | null,
  origin: string | null,
  referer: string | null,
): boolean {
  if (!host) return false;
  const source = origin || referer;
  if (!source) return true;
  try {
    return new URL(source).host === host;
  } catch {
    return false;
  }
}
