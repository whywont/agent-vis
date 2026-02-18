import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

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
