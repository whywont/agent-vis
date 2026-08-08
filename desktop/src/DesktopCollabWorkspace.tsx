import type { SessionMeta } from "@/lib/types";
import DesktopCollabRoom from "./DesktopCollabRoom";

export default function DesktopCollabWorkspace({
  room,
  openWorkerIds,
  activeWorkerId,
  onWorkerViewChange,
}: {
  room: SessionMeta;
  openWorkerIds: string[];
  activeWorkerId: string | null;
  onWorkerViewChange: (openWorkerIds: string[], activeWorkerId: string | null) => void;
}) {
  return (
    <DesktopCollabRoom
      session={room}
      openWorkerIds={openWorkerIds}
      activeWorkerId={activeWorkerId}
      onWorkerViewChange={onWorkerViewChange}
    />
  );
}
