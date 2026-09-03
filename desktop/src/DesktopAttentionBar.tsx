export interface AttentionSession {
  key: string;
  label: string;
  count: number;
  detail: string;
}

export default function DesktopAttentionBar({
  sessions,
  onOpen,
}: {
  sessions: AttentionSession[];
  onOpen: (key: string) => void;
}) {
  const total = sessions.reduce((sum, session) => sum + session.count, 0);
  return (
    <footer className={`desktop-attention-bar${total ? " active" : ""}`} aria-live="polite">
      <span className="desktop-attention-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </svg>
      </span>
      <span className="desktop-attention-summary">
        {total ? `${total} action${total === 1 ? "" : "s"} needed` : "No actions needed"}
      </span>
      {sessions.map((session) => (
        <button
          key={session.key}
          type="button"
          title={session.detail}
          onClick={() => onOpen(session.key)}
        >
          <span>{session.label}</span>
          {session.count > 1 && <b>{session.count}</b>}
        </button>
      ))}
    </footer>
  );
}
