import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { isInsideDir } from "@/lib/path-safety";

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export function GET(req: NextRequest) {
  const filepath = req.nextUrl.searchParams.get("path");
  if (!filepath || !path.isAbsolute(filepath)) {
    return new NextResponse("bad path", { status: 400 });
  }
  // Allow home dir and system temp dirs (Codex stores clipboard images in
  // /var/folders/... on macOS and /tmp/ on Linux). isInsideDir normalizes the
  // path first so "../" cannot escape these roots.
  const allowed =
    isInsideDir(filepath, os.homedir()) ||
    isInsideDir(filepath, "/var/folders") ||
    isInsideDir(filepath, "/tmp");
  if (!allowed) {
    return new NextResponse("path outside allowed directories", { status: 403 });
  }
  if (!fs.existsSync(filepath)) {
    return new NextResponse("not found", { status: 404 });
  }
  const ext = path.extname(filepath).toLowerCase();
  const contentType = MIME_MAP[ext] || "application/octet-stream";
  const buffer = fs.readFileSync(filepath);
  return new NextResponse(buffer, {
    headers: { "Content-Type": contentType },
  });
}
