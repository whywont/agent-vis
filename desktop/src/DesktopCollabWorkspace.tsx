import type { SessionMeta } from "@/lib/types";
import DesktopCollabRoom from "./DesktopCollabRoom";

export default function DesktopCollabWorkspace({
  room,
  selectedWorkerId,
  onSelectedWorkerChange,
}: {
  room: SessionMeta;
  selectedWorkerId: string | null;
  onSelectedWorkerChange: (workerId: string | null) => void;
}) {
  return (
    <section className="desktop-collab-workspace">
      <div className="desktop-collab-workspace-body">
        <DesktopCollabRoom
          session={room}
          selectedWorkerId={selectedWorkerId}
          onSelectedWorkerChange={onSelectedWorkerChange}
        />
      </div>
    </section>
  );
}
