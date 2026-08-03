import { NextRequest, NextResponse } from "next/server";
import { getRuntimeSettings, removeRuntimeSettings, saveRuntimeSettings } from "@/lib/runtime-settings";
import { prepareSettingsChange } from "@/lib/settings-policy";

export async function GET() {
  const settings = await getRuntimeSettings();
  return NextResponse.json({
    ...settings,
    localApiKey: undefined,
    openRouterApiKey: undefined,
    anthropicApiKey: undefined,
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Record<string, unknown>;
  const existingSettings = await getRuntimeSettings();
  const prepared = prepareSettingsChange(body, existingSettings.authConfigured);
  if (!prepared.ok) return new Response(prepared.error, { status: 400 });
  await saveRuntimeSettings(prepared.value.updates);
  if (prepared.value.keysToClear.length) {
    await removeRuntimeSettings(prepared.value.keysToClear);
  }
  return NextResponse.json({ restartRequired: true });
}
