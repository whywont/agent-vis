import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response("No ANTHROPIC_API_KEY set. Add it to .env.local to use AI explain.", { status: 400 });
  }

  const anthropic = new Anthropic();

  const { filepath, patch, contextText } = (await req.json()) as {
    filepath: string;
    patch: string;
    contextText?: string;
  };

  if (!patch?.trim()) {
    return new Response("No patch content", { status: 400 });
  }

  const userContent = contextText?.trim()
    ? `User request that triggered this change:\n"${contextText}"\n\nExplain this patch for ${filepath}:\n\n${patch}`
    : `Explain this patch for ${filepath}:\n\n${patch}`;

  const stream = anthropic.messages.stream({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    system:
      "You are a code reviewer helping developers understand changes. Explain git patches concisely — what changed, what it does, and why it likely matters. Be brief (2-4 sentences for small changes, a short paragraph for complex ones). Skip obvious details like 'a line was added'. Focus on intent and impact.",
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
