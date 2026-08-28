/**
 * Host adapter for local notifications.
 *
 * Inside Electron everything goes through the desktop bridge, so the OS shows
 * the RAS Code icon and the notification survives a hidden window. In a browser
 * it uses the `Notification` API, whose permission is requested the first time
 * the user turns notifications on — never on load.
 */
import type { DerivedNotification } from "@ras-code/client-runtime/notifications";

export type NotificationPermissionState = "unsupported" | "default" | "granted" | "denied";

function desktopNotify() {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.notify;
}

export function readNotificationPermission(): NotificationPermissionState {
  // The desktop shell owns permission at the OS level; there is nothing for the
  // renderer to ask for.
  if (desktopNotify() !== undefined) return "granted";
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** Asks the browser for permission. Safe to call when it was already answered. */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (desktopNotify() !== undefined) return "granted";
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

let audioContext: AudioContext | null = null;

function ensureAudioContext(): AudioContext | null {
  const AudioContextCtor =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (AudioContextCtor === undefined) return null;
  audioContext ??= new AudioContextCtor();
  return audioContext;
}

/**
 * A short two-note chime, synthesized so the app ships no audio asset. The
 * oscillator stops itself, so nothing keeps running between notifications.
 * Silent on desktop, where the OS plays its own notification sound.
 */
export function playNotificationSound(): void {
  if (desktopNotify() !== undefined) return;
  const context = ensureAudioContext();
  if (context === null) return;
  void context.resume().catch(() => {});

  const startedAt = context.currentTime;
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, startedAt);
  gain.gain.exponentialRampToValueAtTime(0.12, startedAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startedAt + 0.32);
  gain.connect(context.destination);

  const oscillator = context.createOscillator();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(660, startedAt);
  oscillator.frequency.setValueAtTime(880, startedAt + 0.11);
  oscillator.connect(gain);
  oscillator.start(startedAt);
  oscillator.stop(startedAt + 0.34);
  oscillator.addEventListener("ended", () => {
    oscillator.disconnect();
    gain.disconnect();
  });
}

/**
 * Shows one notification. `onActivate` runs when the user clicks it; on desktop
 * the click arrives through `onNotificationActivated` instead, so the caller
 * routes by thread id there.
 */
export function showNotification(input: {
  readonly notification: DerivedNotification;
  readonly silent: boolean;
  readonly onActivate: () => void;
}): void {
  const { notification, silent } = input;

  const notify = desktopNotify();
  if (notify !== undefined) {
    void notify({
      id: notification.threadId,
      title: notification.title,
      body: notification.body,
      silent,
    }).catch(() => {});
    return;
  }

  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

  const shown = new Notification(notification.title, {
    body: notification.body,
    // Replaces an older notification for the same transition rather than
    // stacking a second copy.
    tag: notification.dedupeKey,
    silent: true,
  });
  shown.addEventListener("click", () => {
    window.focus();
    shown.close();
    input.onActivate();
  });
}

/** Dock/taskbar badge. Desktop only; browsers get nothing. */
export function setBadgeCount(count: number): void {
  void window.desktopBridge?.setBadgeCount?.(count)?.catch(() => {});
}
