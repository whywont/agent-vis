import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AppEvent, TranscriptSessionMeta } from "@/lib/types";
import { summarizeCapabilities, type McpServerStatus } from "@/lib/session-capabilities";

const STATUS_LABELS: Record<McpServerStatus, string> = {
  connected: "connected",
  needs_auth: "needs sign-in",
  failed: "failed",
  pending: "connecting",
  unknown: "unknown",
};

export default function DesktopCapabilitiesPanel({
  events,
  source,
}: {
  events: AppEvent[];
  source: TranscriptSessionMeta["source"];
}) {
  const [query, setQuery] = useState("");
  const capabilities = useMemo(() => summarizeCapabilities(events), [events]);
  const needle = query.trim().toLowerCase();
  const matches = (value: string) => !needle || value.toLowerCase().includes(needle);

  const servers = capabilities.mcpServers
    .map((server) => ({
      ...server,
      visibleTools: matches(server.label) || matches(server.id) ? server.tools : server.tools.filter(matches),
    }))
    .filter((server) => !needle || server.visibleTools.length || matches(server.label));
  const connected = capabilities.mcpServers.filter((server) => server.status === "connected").length;
  const builtin = capabilities.builtinTools.filter((tool) => matches(tool.name));
  const skills = capabilities.skills.filter(matches);
  const agents = capabilities.agents.filter(matches);
  const plugins = capabilities.plugins.filter(matches);
  const used = capabilities.toolsUsed.filter((tool) => matches(tool.name));

  return (
    <div className="desktop-capabilities" aria-label="Session tools and connectors">
      <input
        className="desktop-capabilities-filter"
        type="search"
        placeholder="Filter tools..."
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Filter tools"
      />
      {!capabilities.hasInventory && (
        <p className="desktop-capabilities-note">
          {source === "codex"
            ? "Codex transcripts don't record which tools were available. Showing the tools this session used."
            : "This transcript doesn't record which tools were available. Showing the tools this session used."}
        </p>
      )}
      {capabilities.hasInventory && (
        <>
          <Section title="MCP servers & connectors" count={`${connected}/${capabilities.mcpServers.length} connected`} open>
            {servers.length ? servers.map((server) => (
              <details className="desktop-capabilities-server" key={server.id} open={Boolean(needle) && server.visibleTools.length > 0}>
                <summary title={server.id}>
                  <i className={`status-${server.status}`} aria-hidden="true" />
                  <span>{server.label}</span>
                  {server.origin !== "local" && <em>{server.origin}</em>}
                  <small>{STATUS_LABELS[server.status]}{server.tools.length ? ` · ${server.tools.length}` : ""}</small>
                </summary>
                <ul>{server.visibleTools.map((tool) => <li key={tool}>{tool}</li>)}</ul>
              </details>
            )) : <Empty filtered={Boolean(needle)} />}
          </Section>
          <Section title="Built-in tools" count={String(capabilities.builtinTools.length)}>
            {builtin.length ? (
              <ul>
                {builtin.map((tool) => (
                  <li key={tool.name}>{tool.name}{tool.onDemand && <small> on demand</small>}</li>
                ))}
              </ul>
            ) : <Empty filtered={Boolean(needle)} />}
          </Section>
          <NameSection title="Skills" names={skills} total={capabilities.skills.length} filtered={Boolean(needle)} />
          <NameSection title="Subagents" names={agents} total={capabilities.agents.length} filtered={Boolean(needle)} />
          <NameSection title="Plugins" names={plugins} total={capabilities.plugins.length} filtered={Boolean(needle)} />
        </>
      )}
      <Section title="Tools used" count={String(capabilities.toolsUsed.length)} open={!capabilities.hasInventory}>
        {used.length ? (
          <ul>
            {used.map((tool) => (
              <li key={tool.name}>{displayToolName(tool.name)}<small> ×{tool.count}</small></li>
            ))}
          </ul>
        ) : <Empty filtered={Boolean(needle)} />}
      </Section>
    </div>
  );
}

function Section({ title, count, open = false, children }: { title: string; count: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="desktop-capabilities-section" open={open}>
      <summary><span>{title}</span><small>{count}</small></summary>
      {children}
    </details>
  );
}

function NameSection({ title, names, total, filtered }: { title: string; names: string[]; total: number; filtered: boolean }) {
  return (
    <Section title={title} count={String(total)}>
      {names.length ? <ul>{names.map((name) => <li key={name}>{name}</li>)}</ul> : <Empty filtered={filtered} />}
    </Section>
  );
}

function Empty({ filtered }: { filtered: boolean }) {
  return <p className="desktop-capabilities-empty">{filtered ? "No matches" : "None"}</p>;
}

function displayToolName(name: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!match) return name;
  return `${match[1].replace(/^claude_ai_/, "").replace(/_/g, " ")} · ${match[2]}`;
}
