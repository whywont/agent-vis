import { NextResponse } from "next/server";
import fs from "fs";

function isDocker(): boolean {
  try {
    return fs.existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

export async function GET() {
  return NextResponse.json({
    platform: process.platform,
    isDocker: isDocker(),
  });
}
