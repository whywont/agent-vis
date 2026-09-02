import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let permissionRequest: Promise<boolean> | null = null;

export function notifyAgentNeedsAttention(sessionName: string, detail: string): void {
  playTerminalPop();
  void notificationPermission().then((granted) => {
    if (!granted) return;
    sendNotification({
      title: "Agent Vis needs your input",
      body: `${sessionName}: ${detail}`,
    });
  }).catch(() => {
    // The in-app attention tray remains available when native notifications fail.
  });
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
