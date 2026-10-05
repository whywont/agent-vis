import type { AppEvent, CapabilitiesEvent } from "./types";

export type McpServerStatus = "connected" | "needs_auth" | "failed" | "pending" | "unknown";

export interface McpServerSummary {
  /** Name as it appears in tool names, e.g. `claude_ai_Google_Drive`. */
  id: string;
  label: string;
  origin: "connector" | "plugin" | "local";
  status: McpServerStatus;
  tools: string[];
}

export interface SessionCapabilities {
  /** True when the transcript recorded what was available, not just what ran. */
  hasInventory: boolean;
  builtinTools: { name: string; onDemand: boolean }[];
  mcpServers: McpServerSummary[];
  skills: string[];
  agents: string[];
  plugins: string[];
  toolsUsed: { name: string; count: number }[];
}

// A connector that only exposes these is installed but not signed in.
const AUTH_ONLY_TOOLS = new Set(["authenticate", "complete_authentication"]);
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;

export function summarizeCapabilities(events: AppEvent[]): SessionCapabilities {
  let loaded = new Set<string>();
  const onDemand = new Set<string>();
  let skills = new Set<string>();
  const agents = new Set<string>();
  const plugins = new Set<string>();
  let reported = new Map<string, string>();
  const failed = new Set<string>();
  const pending = new Set<string>();
  const needsAuth = new Set<string>();
  const used = new Map<string, number>();
  let hasInventory = false;

  for (const event of events) {
    if (event.kind === "capabilities") {
      hasInventory = true;
      apply(event);
      continue;
    }
    const name = event.kind === "tool_call" || event.kind === "file_change" || event.kind === "shell_command"
      ? event.toolName
      : undefined;
    if (name && name !== "local_command") used.set(name, (used.get(name) || 0) + 1);
  }

  function apply(event: CapabilitiesEvent) {
    if (event.tools) loaded = new Set(event.tools);
    event.toolsAdded?.forEach((tool) => onDemand.add(tool));
    event.toolsRemoved?.forEach((tool) => onDemand.delete(tool));
    if (event.mcpServers) reported = new Map(event.mcpServers.map((server) => [serverId(server.name), server.status]));
    // Status lists describe the latest connection attempt, so each one replaces the last.
    replace(failed, event.failedMcpServers);
    replace(pending, event.pendingMcpServers);
    replace(needsAuth, event.needsAuthMcpServers);
    if (event.skills) skills = new Set(event.skills);
    event.skillsAdded?.forEach((skill) => skills.add(skill));
    event.agentsAdded?.forEach((agent) => agents.add(agent));
    event.agentsRemoved?.forEach((agent) => agents.delete(agent));
    event.plugins?.forEach((plugin) => plugins.add(plugin));
  }

  const serverTools = new Map<string, string[]>();
  const builtinTools: SessionCapabilities["builtinTools"] = [];
  for (const tool of new Set([...loaded, ...onDemand])) {
    const match = MCP_TOOL.exec(tool);
    if (match) {
      serverTools.set(match[1], [...serverTools.get(match[1]) || [], match[2]]);
    } else {
      builtinTools.push({ name: tool, onDemand: !loaded.has(tool) });
    }
  }
  for (const id of [...reported.keys(), ...failed, ...pending, ...needsAuth]) {
    if (!serverTools.has(id)) serverTools.set(id, []);
  }

  // Namespaced skills and agents (`plugin:name`) come from plugins.
  for (const name of [...skills, ...agents]) {
    const separator = name.indexOf(":");
    if (separator > 0) plugins.add(name.slice(0, separator));
  }

  const mcpServers = [...serverTools].map(([id, tools]): McpServerSummary => ({
    id,
    ...serverLabel(id),
    status: serverStatus(id, tools),
    tools: tools.sort(),
  })).sort((left, right) => statusRank(left.status) - statusRank(right.status) || left.label.localeCompare(right.label));

  function serverStatus(id: string, tools: string[]): McpServerStatus {
    const status = reported.get(id);
    if (status === "connected" || status === "failed" || status === "pending") return status;
    if (status === "needs-auth" || status === "needs_auth") return "needs_auth";
    if (failed.has(id)) return "failed";
    if (needsAuth.has(id)) return "needs_auth";
    if (pending.has(id)) return "pending";
    if (tools.length && tools.every((tool) => AUTH_ONLY_TOOLS.has(tool))) return "needs_auth";
    return tools.length ? "connected" : "unknown";
  }

  return {
    hasInventory,
    builtinTools: builtinTools.sort((left, right) => Number(left.onDemand) - Number(right.onDemand) || left.name.localeCompare(right.name)),
    mcpServers,
    skills: [...skills].sort(),
    agents: [...agents].sort(),
    plugins: [...plugins].sort(),
    toolsUsed: [...used].map(([name, count]) => ({ name, count })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
  };
}

function replace(target: Set<string>, values: string[] | undefined) {
  if (!values) return;
  target.clear();
  values.forEach((value) => target.add(serverId(value)));
}

// Server lists use display names ("claude.ai Slack") while tool names use
// the sanitized form (`claude_ai_Slack`); key everything by the latter.
function serverId(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

function serverLabel(id: string): Pick<McpServerSummary, "label" | "origin"> {
  if (id.startsWith("claude_ai_")) return { label: id.slice("claude_ai_".length).replace(/_/g, " "), origin: "connector" };
  if (id.startsWith("plugin_")) return { label: id.slice("plugin_".length).replace(/_/g, " "), origin: "plugin" };
  return { label: id, origin: "local" };
}

function statusRank(status: McpServerStatus): number {
  return ["connected", "failed", "pending", "needs_auth", "unknown"].indexOf(status);
}
