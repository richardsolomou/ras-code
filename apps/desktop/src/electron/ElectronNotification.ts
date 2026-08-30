import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";

export interface ElectronNotificationRequest {
  readonly title: string;
  readonly body: string;
  readonly silent: boolean;
  readonly onActivate: () => void;
}

export class ElectronNotification extends Context.Service<
  ElectronNotification,
  {
    /** False when the OS has notifications turned off for the app. */
    readonly show: (request: ElectronNotificationRequest) => Effect.Effect<boolean>;
    /** Dock (macOS) or Unity launcher (Linux) badge. Zero clears it. */
    readonly setBadgeCount: (count: number) => Effect.Effect<boolean>;
  }
>()("@ras-code/desktop/electron/ElectronNotification") {}

export function resolveNotificationIcon(
  iconPaths: DesktopAssets.DesktopIconPaths,
): string | undefined {
  return Option.getOrUndefined(
    Option.isSome(iconPaths.icns)
      ? iconPaths.icns
      : Option.isSome(iconPaths.png)
        ? iconPaths.png
        : iconPaths.ico,
  );
}

export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const iconPaths = yield* assets.iconPaths.pipe(
    Effect.orElseSucceed(() => ({
      ico: Option.none<string>(),
      icns: Option.none<string>(),
      png: Option.none<string>(),
    })),
  );
  const icon = resolveNotificationIcon(iconPaths);

  return ElectronNotification.of({
    show: (request) =>
      Effect.sync(() => {
        if (!Electron.Notification.isSupported()) return false;

        const notification = new Electron.Notification({
          title: request.title,
          body: request.body,
          silent: request.silent,
          ...(icon === undefined ? {} : { icon }),
        });
        notification.on("click", request.onActivate);
        notification.show();
        return true;
      }),
    setBadgeCount: (count) =>
      Effect.sync(() => Electron.app.setBadgeCount(Math.max(0, Math.trunc(count)))),
  });
});

export const layer = Layer.effect(ElectronNotification, make);
