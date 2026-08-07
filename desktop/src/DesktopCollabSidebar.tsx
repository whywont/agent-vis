import { useEffect, useState } from "react";
import type { SessionMeta } from "@/lib/types";
import { deleteCollabRoom, getCollabRoomState, type CollabRoomState } from "./desktop-api";

export default function DesktopCollabSidebar({
  rooms,
  selectedRoom,
  selectedWorkerId,
  onSelectRoom,
  onSelectWorker,
  onCreateRoom,
  onExit,
  onRoomDeleted,
}: {
  rooms: SessionMeta[];
  selectedRoom: SessionMeta | null;
  selectedWorkerId: string | null;
  onSelectRoom: (room: SessionMeta) => void;
  onSelectWorker: (room: SessionMeta, workerId: string) => void;
  onCreateRoom: () => void;
  onExit: () => void;
  onRoomDeleted: (room: SessionMeta) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(selectedRoom ? [selectedRoom.id] : []));
  const [roomStates, setRoomStates] = useState<Record<string, CollabRoomState>>({});

  useEffect(() => {
    let cancelled = false;
    const refresh = () => void Promise.all(rooms.map(async (room) => [room.id, await getCollabRoomState(room.file)] as const))
      .then((entries) => { if (!cancelled) setRoomStates(Object.fromEntries(entries)); })
      .catch(() => {});
    refresh();
    window.addEventListener("collab-room-state-changed", refresh);
    return () => { cancelled = true; window.removeEventListener("collab-room-state-changed", refresh); };
  }, [rooms]);

  function toggleRoom(room: SessionMeta) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(room.id)) next.delete(room.id);
      else next.add(room.id);
      return next;
    });
    onSelectRoom(room);
  }

  return (
    <div className="desktop-collab-sidebar">
      <header>
        <div><span>Custom sessions</span><strong>Collab</strong></div>
        <button type="button" onClick={onCreateRoom} title="New collaboration room">+</button>
      </header>
      <div className="desktop-collab-sidebar-rooms">
        {rooms.map((room) => {
          const state = roomStates[room.id];
          const open = expanded.has(room.id) || selectedRoom?.id === room.id;
          const selected = selectedRoom?.id === room.id && !selectedWorkerId;
          return <section key={room.id} className={selectedRoom?.id === room.id ? "active-room" : ""}>
            <div className={`desktop-collab-room-row${selected ? " active" : ""}`}>
              <button className="twisty" type="button" onClick={() => toggleRoom(room)} aria-label={`${open ? "Collapse" : "Expand"} ${room.customName || room.project}`}>{open ? "v" : ">"}</button>
              <button className="room-name" type="button" onClick={() => onSelectRoom(room)}><b>{room.customName || room.project || room.id}</b><small>{state?.workers.length || 0} participants</small></button>
              <button className="room-delete" type="button" title="Delete room" onClick={() => void deleteCollabRoom(room.file).then(() => onRoomDeleted(room))}>x</button>
            </div>
            {open && <div className="desktop-collab-participant-tree">
              <button className={selected ? "active" : ""} type="button" onClick={() => onSelectRoom(room)}><i className="group">#</i><span>group chat</span></button>
              {state?.workers.map((worker) => <button key={worker.id} className={selectedRoom?.id === room.id && selectedWorkerId === worker.id ? "active" : ""} type="button" onClick={() => onSelectWorker(room, worker.id)}><i className={`runtime ${worker.runtimeStatus}`} /><span>{worker.name}<small>{worker.provider}</small></span></button>)}
            </div>}
          </section>;
        })}
        {!rooms.length && <p>No custom rooms yet.</p>}
      </div>
      <footer><button type="button" onClick={onExit}>&larr; Sessions</button></footer>
    </div>
  );
}
