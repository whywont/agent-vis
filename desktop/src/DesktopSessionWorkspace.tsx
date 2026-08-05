import type { SessionMeta } from "@/lib/types";
import type { SessionMatchTarget } from "./App";
import DesktopSessionDetail from "./DesktopSessionDetail";

export default function DesktopSessionWorkspace({
  primary,
  secondary,
  primaryName,
  secondaryName,
  activeTab,
  terminalOpen,
  matchTarget,
  onActiveTabChange,
  onTerminalOpen,
  onTerminalClose,
  liveSessionKey,
}: {
  primary: SessionMeta;
  secondary: SessionMeta | null;
  primaryName: string | null;
  secondaryName: string | null;
  activeTab: "session" | "files";
  terminalOpen: boolean;
  matchTarget: SessionMatchTarget | null;
  onActiveTabChange: (tab: "session" | "files") => void;
  onTerminalOpen: (session: SessionMeta) => void;
  onTerminalClose: () => void;
  liveSessionKey?: string;
}) {
  const split = Boolean(secondary);
  return (
    <div className={`desktop-session-workspace${split ? " split" : ""}`}>
      <div className="desktop-split-pane desktop-split-primary">
        <DesktopSessionDetail
          key={`${primary.source}:${primary.id}:${primary.file}`}
          session={primary}
          sessionName={primaryName}
          activeTab={activeTab}
          terminalOpen={terminalOpen}
          splitView={split}
          onActiveTabChange={onActiveTabChange}
          onTerminalOpen={() => onTerminalOpen(primary)}
          onTerminalClose={onTerminalClose}
          matchTarget={matchTarget}
          liveSessionKey={liveSessionKey}
        />
      </div>
      {secondary && (
        <div className="desktop-split-pane">
          <DesktopSessionDetail
            key={`${secondary.source}:${secondary.id}:${secondary.file}`}
            session={secondary}
            sessionName={secondaryName}
            activeTab="session"
            terminalOpen={terminalOpen}
            splitView
            onActiveTabChange={() => {}}
            onTerminalOpen={() => onTerminalOpen(secondary)}
            onTerminalClose={onTerminalClose}
            matchTarget={null}
          />
        </div>
      )}
    </div>
  );
}
