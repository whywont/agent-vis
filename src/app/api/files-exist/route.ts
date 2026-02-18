import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function POST(req: NextRequest) {
  const body = await req.json() as { paths?: unknown };
  const paths = body.paths;
  if (!Array.isArray(paths)) {
    return NextResponse.json({ error: "paths array required" }, { status: 400 });
  }

  const results: Record<string, boolean> = {};
  for (const p of paths) {
    if (typeof p !== "string" || !path.isAbsolute(p)) {
      results[p as string] = false;
      continue;
    }
    results[p] = fs.existsSync(p);
  }

  return NextResponse.json({ results });
}
