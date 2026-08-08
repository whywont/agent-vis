import type { AppEvent, SessionMeta, TranscriptSessionMeta } from "@/lib/types";
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
  onOpenCollab,
  onTerminalClose,
  liveSessionKey,
  initialDraft,
  initialEvents,
  onLiveActivity,
  onContinuationDraftSent,
  sessions,
  onOpenSession,
  onSplitSession,
}: {
  primary: TranscriptSessionMeta;
  secondary: TranscriptSessionMeta | null;
  primaryName: string | null;
  secondaryName: string | null;
  activeTab: "session" | "files" | "testing" | "editor";
  terminalOpen: boolean;
  matchTarget: SessionMatchTarget | null;
  onActiveTabChange: (tab: "session" | "files" | "testing" | "editor") => void;
  onTerminalOpen: (session: TranscriptSessionMeta) => void;
  onOpenCollab: () => void;
  onTerminalClose: () => void;
  liveSessionKey?: string;
  initialDraft?: string;
  initialEvents?: AppEvent[];
  onLiveActivity?: () => void;
  onContinuationDraftSent?: () => void;
  sessions: SessionMeta[];
  onOpenSession: (sessionId: string) => void;
  onSplitSession: (sessionId: string) => void;
}) {
  const split = Boolean(secondary);
  return (
    <div className={`desktop-session-workspace${split ? " split" : ""}`}>
      <div className="desktop-split-pane desktop-split-primary">
        <DesktopSessionDetail
          key={`${primary.source}:${primary.id}:${primary.file}:${initialEvents?.length ? "continued" : "new"}`}
          session={primary}
          sessionName={primaryName}
          activeTab={activeTab}
          terminalOpen={terminalOpen}
          splitView={split}
          onActiveTabChange={onActiveTabChange}
          onTerminalOpen={() => onTerminalOpen(primary)}
          onOpenCollab={onOpenCollab}
          onTerminalClose={onTerminalClose}
          matchTarget={matchTarget}
          liveSessionKey={liveSessionKey}
          initialDraft={initialDraft}
          initialEvents={initialEvents}
          onLiveActivity={onLiveActivity}
          onContinuationDraftSent={onContinuationDraftSent}
          relatedSessions={sessions}
          onOpenSession={onOpenSession}
          onSplitSession={onSplitSession}
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
            relatedSessions={sessions}
            onOpenSession={onOpenSession}
            onSplitSession={onSplitSession}
          />
        </div>
      )}
    </div>
  );
}
