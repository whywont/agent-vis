import {
  isPermissionGranted,
  onAction,
  registerActionTypes,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { SessionAttention } from "./session-attention";
import type { NotificationApprovalAction } from "./notification-approval";

let permissionRequest: Promise<boolean> | null = null;
let actionTypeRegistration: Promise<void> | null = null;
let nextNotificationId = 10_000;
const approvalNotifications = new Map<number, SessionAttention>();
const APPROVAL_ACTION_TYPE = "agent-vis-approval";

export function notifyAgentNeedsAttention(sessionName: string, detail: string, attention: SessionAttention): void {
  playTerminalPop();
  void Promise.all([notificationPermission(), ensureApprovalActionType()]).then(([granted]) => {
    if (!granted) return;
    const options: Parameters<typeof sendNotification>[0] = {
      title: "Agent Vis needs your input",
      body: `${sessionName}: ${detail}`,
      sound: "Ping",
    };
    if (attention.request.type === "approval") {
      const id = allocateNotificationId();
      approvalNotifications.set(id, attention);
      Object.assign(options, { id, actionTypeId: APPROVAL_ACTION_TYPE });
    }
    sendNotification(options);
  }).catch(() => {
    // The in-app attention tray remains available when native notifications fail.
  });
}

export async function listenForNotificationApprovalActions(
  handler: (attention: SessionAttention, action: NotificationApprovalAction) => void | Promise<void>,
): Promise<() => void> {
  await ensureApprovalActionType();
  const listener = await onAction((payload) => {
    const event = payload as unknown as {
      actionId?: string;
      notification?: { id?: number };
    };
    const action = event.actionId === "allow" || event.actionId === "decline"
      ? event.actionId
      : null;
    const id = event.notification?.id;
    if (!action || typeof id !== "number") return;
    const attention = approvalNotifications.get(id);
    if (!attention) return;
    approvalNotifications.delete(id);
    void handler(attention, action);
  });
  return () => void listener.unregister();
}

function ensureApprovalActionType(): Promise<void> {
  if (actionTypeRegistration) return actionTypeRegistration;
  actionTypeRegistration = registerActionTypes([{
    id: APPROVAL_ACTION_TYPE,
    actions: [
      { id: "allow", title: "Allow", requiresAuthentication: true },
      { id: "decline", title: "Decline", destructive: true },
    ],
  }]);
  return actionTypeRegistration;
}

function allocateNotificationId(): number {
  do {
    nextNotificationId = nextNotificationId >= 2_000_000_000 ? 10_000 : nextNotificationId + 1;
  } while (approvalNotifications.has(nextNotificationId));
  return nextNotificationId;
}

async function notificationPermission(): Promise<boolean> {
  if (permissionRequest) return permissionRequest;
  permissionRequest = (async () => {
    if (await isPermissionGranted()) return true;
    return await requestPermission() === "granted";
  })();
  return permissionRequest;
}

function playTerminalPop(): void {
  const AudioContextClass = window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(620, context.currentTime + 0.11);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.13, context.currentTime + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.14);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.14);
    oscillator.addEventListener("ended", () => void context.close(), { once: true });
  } catch {
    // Audio can be blocked until the first user gesture; the visual alert still appears.
  }
}
