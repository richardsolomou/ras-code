import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
/** A 1024px flat-colour tile stays far below this; anything larger is refused. */
const MAX_DATA_URL_CHARS = 4_000_000;

export const setDockIcon = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_DOCK_ICON_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.dockIcon.setDockIcon")(function* (pngDataUrl) {
    if (!pngDataUrl.startsWith(PNG_DATA_URL_PREFIX)) return false;
    if (pngDataUrl.length > MAX_DATA_URL_CHARS) return false;
    const app = yield* ElectronApp.ElectronApp;
    return yield* app.setDockIconImage(pngDataUrl);
  }),
});
