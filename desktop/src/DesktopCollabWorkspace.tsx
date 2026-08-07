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
    <DesktopCollabRoom
      session={room}
      selectedWorkerId={selectedWorkerId}
      onSelectedWorkerChange={onSelectedWorkerChange}
    />
  );
}
