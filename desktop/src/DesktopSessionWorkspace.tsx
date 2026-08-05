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
}) {
  const split = Boolean(secondary);
  return (
    <div className={`desktop-session-workspace${split ? " split" : ""}`}>
      <div className="desktop-split-pane desktop-split-primary">
        <DesktopSessionDetail
        session={primary}
        sessionName={primaryName}
        activeTab={activeTab}
        terminalOpen={terminalOpen}
        splitView={split}
        onActiveTabChange={onActiveTabChange}
        onTerminalOpen={() => onTerminalOpen(primary)}
        onTerminalClose={onTerminalClose}
        matchTarget={matchTarget}
      />
      </div>
      {secondary && (
        <div className="desktop-split-pane">
          <DesktopSessionDetail
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
