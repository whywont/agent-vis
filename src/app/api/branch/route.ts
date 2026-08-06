import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import path from "path";
import os from "os";
import { resolveExistingPathInsideDirs } from "@/lib/path-safety";

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  if (!cwd || !path.isAbsolute(cwd)) {
    return NextResponse.json({ branch: null }, { status: 400 });
  }
  const safeCwd = resolveExistingPathInsideDirs(cwd, [os.homedir()]);
  if (!safeCwd) {
    return NextResponse.json({ branch: null }, { status: 403 });
  }

  return new Promise<NextResponse>((resolve) => {
    execFile(
      "git",
      ["branch", "--show-current"],
      { cwd: safeCwd, timeout: 3000 },
      (err, stdout) => {
        if (err) {
          resolve(NextResponse.json({ branch: null }));
        } else {
          resolve(NextResponse.json({ branch: stdout.trim() || null }));
        }
      }
    );
  });
}
