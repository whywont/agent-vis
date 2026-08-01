import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getRuntimeSettings } from "@/lib/runtime-settings";

export async function POST(req: NextRequest) {
  const settings = await getRuntimeSettings();

  const { filepath, patch, contextText, fileContent } = (await req.json()) as {
    filepath: string;
    patch: string;
    contextText?: string;
    fileContent?: string | null;
  };

  if (!patch?.trim()) {
    return new Response("No patch content", { status: 400 });
  }

  const requestContext = contextText?.trim()
    ? `User request that triggered this change:\n"${contextText}"\n\n`
    : "";
  const fileContext = typeof fileContent === "string"
    ? `\n\nCurrent complete file for context:\n\n${fileContent}`
    : "";
  const userContent = `${requestContext}Explain this patch for ${filepath}:\n\n${patch}${fileContext}`;

  const system =
    "You are a code reviewer helping developers understand changes. Explain git patches concisely — what changed, what it does, and why it likely matters. The current complete file is supplied for surrounding context; the patch is authoritative about the change itself. Be brief (2-4 sentences for small changes, a short paragraph for complex ones). Skip obvious details like 'a line was added'. Focus on intent and impact.";

  if (settings.provider === "openai-compatible" || settings.provider === "openrouter") {
    const baseUrl = settings.provider === "openrouter"
      ? "https://openrouter.ai/api/v1"
      : settings.localBaseUrl;
    const apiKey = settings.provider === "openrouter"
      ? settings.openRouterApiKey
      : settings.localApiKey;
    if (settings.provider === "openrouter" && !apiKey) {
      return new Response("Add an OpenRouter API key in Settings to use OpenRouter.", { status: 400 });
    }
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(settings.provider === "openrouter" ? { "HTTP-Referer": "http://agent-vis.local", "X-Title": "agent-vis" } : {}),
        },
        body: JSON.stringify({
          model: settings.model,
          stream: false,
          max_tokens: 512,
          messages: [{ role: "system", content: system }, { role: "user", content: userContent }],
        }),
      });
      if (!response.ok) return new Response(`Local model request failed: ${await response.text()}`, { status: 502 });
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = payload.choices?.[0]?.message?.content;
      if (!text) return new Response("Local model returned no explanation.", { status: 502 });
      return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    } catch (error) {
      return new Response(`Could not reach local model: ${(error as Error).message}`, { status: 502 });
    }
  }

  if (!settings.anthropicApiKey) {
    return new Response("Add an Anthropic API key in Settings to use hosted explanations.", { status: 400 });
  }
  const anthropic = new Anthropic({ apiKey: settings.anthropicApiKey });
  const stream = anthropic.messages.stream({
    model: settings.model,
    max_tokens: 512,
    system,
    messages: [
      {
        role: "user",
        content: userContent,
      },
    ],
  });

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            controller.enqueue(new TextEncoder().encode(event.delta.text));
          }
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
