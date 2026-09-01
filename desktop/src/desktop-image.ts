import { convertFileSrc } from "@tauri-apps/api/core";

const WEB_IMAGE_ROUTE = "/api/image";

/**
 * Translate the web transcript's local-image route into a Tauri asset URL.
 * Data URLs (Claude) and already-usable URLs pass through unchanged.
 */
export function desktopImageSrc(
  source: string,
  convert: (path: string) => string = convertFileSrc,
): string {
  if (!source.startsWith(`${WEB_IMAGE_ROUTE}?`)) return source;

  const params = new URLSearchParams(source.slice(source.indexOf("?") + 1));
  const path = params.get("path");
  return path?.startsWith("/") ? convert(path) : source;
}
