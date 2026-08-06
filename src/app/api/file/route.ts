import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { resolveExistingPathInsideDirs } from "@/lib/path-safety";

export async function POST(req: NextRequest) {
  const body = await req.json() as { path?: unknown; content?: unknown };
  const filepath = typeof body.path === "string" ? body.path : null;
  const content = typeof body.content === "string" ? body.content : null;

  if (!filepath || !path.isAbsolute(filepath)) {
    return NextResponse.json({ error: "absolute path required" }, { status: 400 });
  }
  const safePath = resolveExistingPathInsideDirs(filepath, [os.homedir()]);
  if (!safePath) {
    return NextResponse.json({ error: "path outside home" }, { status: 403 });
  }
  if (content === null) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  try {
    const descriptor = fs.openSync(
      safePath,
      fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    );
    try {
      fs.writeFileSync(descriptor, content, "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export function GET(req: NextRequest) {
  const filepath = req.nextUrl.searchParams.get("path");
  if (!filepath || !path.isAbsolute(filepath)) {
    return NextResponse.json({ error: "absolute path required" }, { status: 400 });
  }
  const safePath = resolveExistingPathInsideDirs(filepath, [os.homedir()]);
  if (!safePath) {
    return NextResponse.json({ error: "path outside home" }, { status: 403 });
  }
  try {
    const content = fs.readFileSync(safePath, "utf8");
    return NextResponse.json({ content });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
