import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function POST(req: NextRequest) {
  const body = await req.json() as { paths?: unknown; cwd?: unknown };
  const inputPaths = body.paths;
  const cwd = typeof body.cwd === "string" ? body.cwd : "";

  if (!Array.isArray(inputPaths)) {
    return NextResponse.json({ error: "paths array required" }, { status: 400 });
  }

  const resolved: Record<string, string | null> = {};
  for (const p of inputPaths) {
    if (typeof p !== "string") { resolved[String(p)] = null; continue; }
    try {
      const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
      resolved[p] = fs.realpathSync(abs);
    } catch {
      resolved[p] = null;
    }
  }

  return NextResponse.json({ resolved });
}
