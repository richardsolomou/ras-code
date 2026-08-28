import { DesktopNotificationSchema } from "@ras-code/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronNotification from "../../electron/ElectronNotification.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const notify = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.NOTIFY_CHANNEL,
  payload: DesktopNotificationSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.notifications.notify")(function* (notification) {
    const notifications = yield* ElectronNotification.ElectronNotification;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    // The click lands long after this handler returns, so both the effect and
    // the services it runs with are captured now.
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const revealAndRoute = Effect.gen(function* () {
      const window = yield* electronWindow.currentMainOrFirst;
      if (Option.isNone(window)) return;
      yield* electronWindow.reveal(window.value);
      yield* electronWindow.sendAll(IpcChannels.NOTIFICATION_ACTIVATED_CHANNEL, notification.id);
    });

    return yield* notifications.show({
      title: notification.title,
      body: notification.body,
      silent: notification.silent,
      onActivate: () => {
        runFork(revealAndRoute);
      },
    });
  }),
});

export const setBadgeCount = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_BADGE_COUNT_CHANNEL,
  payload: Schema.Number,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.notifications.setBadgeCount")(function* (count) {
    const notifications = yield* ElectronNotification.ElectronNotification;
    return yield* notifications.setBadgeCount(count);
  }),
});
