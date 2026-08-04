import { promises as fs } from "node:fs";
import path from "node:path";

export type ExplainProvider = "anthropic" | "openai-compatible" | "openrouter";

export type RuntimeSettings = {
  provider: ExplainProvider;
  model: string;
  localBaseUrl: string;
  localApiKey: string;
  openRouterApiKey: string;
  anthropicApiKey: string;
  tailscaleHost: string;
  remoteTerminal: boolean;
  remoteAgentChat: boolean;
  authConfigured: boolean;
  anthropicKeyConfigured: boolean;
  localKeyConfigured: boolean;
  openRouterKeyConfigured: boolean;
};

const ENV_PATH = path.join(process.cwd(), ".env.local");

async function readEnv(): Promise<Record<string, string>> {
  try {
    const contents = await fs.readFile(ENV_PATH, "utf8");
    const entries: Record<string, string> = {};
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      entries[match[1]] = match[2].replace(/^("|')|\1$/g, "");
    }
    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function tailscaleHost(env: Record<string, string>): string {
  const hosts = (env.HOSTS || env.AGENT_VIS_HOSTS || env.HOST || env.AGENT_VIS_HOST || "127.0.0.1")
    .split(",")
    .map((host) => host.trim());
  return hosts.find((host) => host && !["127.0.0.1", "localhost", "::1"].includes(host)) || "";
}

export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  // .env.local deliberately wins here so a saved setting takes effect without
  // needing to recreate the Next process. Network binding still needs restart.
  const env = { ...process.env, ...(await readEnv()) } as Record<string, string>;
  const provider: ExplainProvider = ["anthropic", "openai-compatible", "openrouter"].includes(env.AGENT_VIS_EXPLAIN_PROVIDER)
    ? env.AGENT_VIS_EXPLAIN_PROVIDER as ExplainProvider
    : "anthropic";
  return {
    provider,
    model: env.AGENT_VIS_EXPLAIN_MODEL || (provider === "anthropic" ? "claude-haiku-4-5" : provider === "openrouter" ? "google/gemini-2.5-flash-lite" : "qwen3:8b"),
    localBaseUrl: (env.AGENT_VIS_LOCAL_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/$/, ""),
    localApiKey: env.AGENT_VIS_LOCAL_API_KEY || "",
    openRouterApiKey: env.OPENROUTER_API_KEY || "",
    anthropicApiKey: env.ANTHROPIC_API_KEY || "",
    tailscaleHost: tailscaleHost(env),
    remoteTerminal: env.AGENT_VIS_ALLOW_REMOTE_TERMINAL === "1",
    remoteAgentChat: env.AGENT_VIS_ALLOW_REMOTE_AGENT_CHAT === "1",
    authConfigured: Boolean(env.AGENT_VIS_AUTH_TOKEN),
    anthropicKeyConfigured: Boolean(env.ANTHROPIC_API_KEY),
    localKeyConfigured: Boolean(env.AGENT_VIS_LOCAL_API_KEY),
    openRouterKeyConfigured: Boolean(env.OPENROUTER_API_KEY),
  };
}

export async function saveRuntimeSettings(values: Record<string, string>) {
  let contents = "";
  try {
    contents = await fs.readFile(ENV_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const [key, value] of Object.entries(values)) {
    const expression = new RegExp(`^\\s*${key}=.*$`, "m");
    const line = `${key}=${value}`;
    contents = expression.test(contents)
      ? contents.replace(expression, line)
      : `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  await fs.writeFile(ENV_PATH, contents, { mode: 0o600 });
}

export async function removeRuntimeSettings(keys: string[]) {
  let contents = "";
  try {
    contents = await fs.readFile(ENV_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const wanted = new Set(keys);
  const next = contents
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      return !match || !wanted.has(match[1]);
    })
    .join("\n");
  await fs.writeFile(ENV_PATH, next, { mode: 0o600 });
}
