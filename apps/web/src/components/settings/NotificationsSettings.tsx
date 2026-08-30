import { useState } from "react";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationEventKind,
  type NotificationSettings,
} from "@ras-code/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import {
  playNotificationSound,
  readNotificationPermission,
  requestNotificationPermission,
  showNotification,
  type NotificationPermissionState,
} from "~/notifications/deliver";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const EVENT_ROWS: ReadonlyArray<{
  readonly kind: NotificationEventKind;
  readonly title: string;
  readonly description: string;
}> = [
  {
    kind: "turnCompleted",
    title: "Agent finished",
    description: "The agent completed a turn.",
  },
  { kind: "turnFailed", title: "Agent failed", description: "A turn ended with an error." },
  {
    kind: "approvalRequested",
    title: "Approval needed",
    description: "The agent is waiting for you to approve an action.",
  },
  {
    kind: "userInputRequested",
    title: "Input needed",
    description: "The agent asked you a question.",
  },
  {
    kind: "fallbackEngaged",
    title: "Provider fallback",
    description: "A thread continued through the PostHog AI Gateway.",
  },
];

function permissionHint(permission: NotificationPermissionState): string | null {
  if (permission === "denied") {
    return "Your browser is blocking notifications for RAS Code. Allow them in your browser's site settings.";
  }
  if (permission === "unsupported") {
    return "This browser does not support notifications.";
  }
  return null;
}

export function NotificationsSettingsSection() {
  const notifications = usePrimarySettings((settings) => settings.notifications);
  const updateSettings = useUpdatePrimarySettings();
  const [permission, setPermission] = useState<NotificationPermissionState>(
    readNotificationPermission,
  );

  // Client settings are shallow-merged, so every write carries the whole object.
  const update = (patch: Partial<NotificationSettings>) => {
    updateSettings({ notifications: { ...notifications, ...patch } });
  };

  const setEnabled = async (enabled: boolean) => {
    if (enabled) {
      setPermission(await requestNotificationPermission());
    }
    update({ enabled });
  };

  const sendTestNotification = () => {
    showNotification({
      notification: {
        kind: "turnCompleted",
        threadId: "notification-test",
        title: "RAS Code notifications are on",
        body: "This is what a notification looks like.",
        dedupeKey: "notification-test",
      },
      silent: !notifications.sound,
      onActivate: () => {},
    });
    if (notifications.sound) playNotificationSound();
  };

  const hint = permissionHint(permission);

  return (
    <SettingsSection title="Notifications" id="notifications">
      <SettingsRow
        {...searchableSetting("notifications")}
        description="Tell me when a thread finishes, fails, or needs me."
        status={hint}
        resetAction={
          notifications.enabled !== DEFAULT_NOTIFICATION_SETTINGS.enabled ? (
            <SettingResetButton
              label="notifications"
              onClick={() => update({ enabled: DEFAULT_NOTIFICATION_SETTINGS.enabled })}
            />
          ) : null
        }
        control={
          <Switch
            checked={notifications.enabled}
            onCheckedChange={(checked) => void setEnabled(Boolean(checked))}
            aria-label="Notifications"
          />
        }
      />

      {notifications.enabled ? (
        <>
          <SettingsRow
            {...searchableSetting("notification-sound")}
            description="Play a short chime with each notification."
            control={
              <Switch
                checked={notifications.sound}
                onCheckedChange={(checked) => update({ sound: Boolean(checked) })}
                aria-label="Notification sound"
              />
            }
          />

          <SettingsRow
            {...searchableSetting("notifications-only-when-unfocused")}
            description="Stay quiet while RAS Code is the window you are looking at."
            control={
              <Switch
                checked={notifications.onlyWhenUnfocused}
                onCheckedChange={(checked) => update({ onlyWhenUnfocused: Boolean(checked) })}
                aria-label="Only notify when unfocused"
              />
            }
          />

          {EVENT_ROWS.map((row) => (
            <SettingsRow
              key={row.kind}
              title={row.title}
              description={row.description}
              control={
                <Switch
                  checked={notifications.events[row.kind]}
                  onCheckedChange={(checked) =>
                    update({ events: { ...notifications.events, [row.kind]: Boolean(checked) } })
                  }
                  aria-label={row.title}
                />
              }
            />
          ))}

          <SettingsRow
            title="Test notification"
            description="Check that notifications reach you."
            control={
              <Button variant="secondary" onClick={sendTestNotification}>
                Send test notification
              </Button>
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
