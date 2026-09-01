import { describe, expect, it, vi } from "vitest";
import { desktopImageSrc } from "./desktop-image";

describe("desktopImageSrc", () => {
  it("converts the web local-image route to a Tauri asset URL", () => {
    const convert = vi.fn((path: string) => `asset://${path}`);

    expect(desktopImageSrc(
      "/api/image?path=%2Fvar%2Ffolders%2Ftmp%2Fclipboard.png",
      convert,
    )).toBe("asset:///var/folders/tmp/clipboard.png");
    expect(convert).toHaveBeenCalledWith("/var/folders/tmp/clipboard.png");
  });

  it("leaves data and remote URLs unchanged", () => {
    const convert = vi.fn((path: string) => `asset://${path}`);

    expect(desktopImageSrc("data:image/png;base64,abc", convert)).toBe("data:image/png;base64,abc");
    expect(desktopImageSrc("https://example.com/image.png", convert)).toBe("https://example.com/image.png");
    expect(convert).not.toHaveBeenCalled();
  });

  it("does not convert malformed or relative image-route paths", () => {
    const convert = vi.fn((path: string) => `asset://${path}`);

    expect(desktopImageSrc("/api/image?path=relative.png", convert)).toBe("/api/image?path=relative.png");
    expect(desktopImageSrc("/api/image?other=value", convert)).toBe("/api/image?other=value");
    expect(convert).not.toHaveBeenCalled();
  });
});
