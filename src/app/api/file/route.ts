import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

export async function POST(req: NextRequest) {
  const body = await req.json() as { path?: unknown; content?: unknown };
  const filepath = typeof body.path === "string" ? body.path : null;
  const content = typeof body.content === "string" ? body.content : null;

  if (!filepath || !path.isAbsolute(filepath)) {
    return NextResponse.json({ error: "absolute path required" }, { status: 400 });
  }
  const home = os.homedir();
  if (!filepath.startsWith(home)) {
    return NextResponse.json({ error: "path outside home" }, { status: 403 });
  }
  if (content === null) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  try {
    fs.writeFileSync(filepath, content, "utf8");
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
  const home = os.homedir();
  if (!filepath.startsWith(home)) {
    return NextResponse.json({ error: "path outside home" }, { status: 403 });
  }
  if (!fs.existsSync(filepath)) {
    return NextResponse.json({ error: "not found", content: null }, { status: 404 });
  }
  try {
    const content = fs.readFileSync(filepath, "utf8");
    return NextResponse.json({ content });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
