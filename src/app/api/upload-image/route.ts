import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import os from "os";
import path from "path";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
};

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("image");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing image" }, { status: 400 });
  }

  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "file must be an image" }, { status: 400 });
  }

  if (file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "image too large" }, { status: 413 });
  }

  const ext = (MIME_TO_EXT[file.type] ?? path.extname(file.name).slice(0, 12)) || ".img";
  const dir = path.join(os.tmpdir(), "agent-vis-uploads");
  const filepath = path.join(dir, `${Date.now()}-${randomUUID()}${ext}`);
  const bytes = Buffer.from(await file.arrayBuffer());

  await mkdir(dir, { recursive: true });
  await writeFile(filepath, bytes, { flag: "wx" });

  return NextResponse.json({ path: filepath });
}
