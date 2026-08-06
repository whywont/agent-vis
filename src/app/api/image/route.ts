import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { resolveExistingPathInsideDirs } from "@/lib/path-safety";

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
  // Codex stores clipboard images in the system temp directory. Canonicalize
  // the file so a symlink in an allowed directory cannot expose another path.
  const safePath = resolveExistingPathInsideDirs(filepath, [
    os.homedir(),
    os.tmpdir(),
    "/var/folders",
    "/tmp",
  ]);
  if (!safePath) {
    return new NextResponse("path outside allowed directories", { status: 403 });
  }
  const ext = path.extname(safePath).toLowerCase();
  const contentType = MIME_MAP[ext] || "application/octet-stream";
  const buffer = fs.readFileSync(safePath);
  return new NextResponse(buffer, {
    headers: { "Content-Type": contentType },
  });
}
