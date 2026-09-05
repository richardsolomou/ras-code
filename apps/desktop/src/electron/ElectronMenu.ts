import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

export interface ElectronMenuTemplateInput {
  readonly window: Electron.BrowserWindow;
  readonly template: readonly Electron.MenuItemConstructorOptions[];
}

const ElectronMenuOperation = Schema.Literals(["set-application-menu", "popup-template"]);

export class ElectronMenuOperationError extends Schema.TaggedErrorClass<ElectronMenuOperationError>()(
  "ElectronMenuOperationError",
  {
    operation: ElectronMenuOperation,
    platform: Schema.String,
    windowId: Schema.NullOr(Schema.Number),
    itemCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const window = this.windowId === null ? "" : ` for window ${this.windowId}`;
    return `Electron menu operation ${JSON.stringify(this.operation)} failed${window} with ${this.itemCount} items on ${this.platform}.`;
  }
}

export class ElectronMenu extends Context.Service<
  ElectronMenu,
  {
    readonly setApplicationMenu: (
      template: readonly Electron.MenuItemConstructorOptions[],
    ) => Effect.Effect<void>;
    readonly popupTemplate: (input: ElectronMenuTemplateInput) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronMenu") {}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  return ElectronMenu.of({
    setApplicationMenu: (template) =>
      Effect.try({
        try: () => {
          Electron.Menu.setApplicationMenu(Electron.Menu.buildFromTemplate([...template]));
        },
        catch: (cause) =>
          new ElectronMenuOperationError({
            operation: "set-application-menu",
            platform,
            windowId: null,
            itemCount: template.length,
            cause,
          }),
      }).pipe(Effect.orDie),
    popupTemplate: (input) =>
      input.template.length === 0
        ? Effect.void
        : Effect.try({
            try: () =>
              Electron.Menu.buildFromTemplate([...input.template]).popup({
                window: input.window,
              }),
            catch: (cause) =>
              new ElectronMenuOperationError({
                operation: "popup-template",
                platform,
                windowId: input.window.id,
                itemCount: input.template.length,
                cause,
              }),
          }).pipe(Effect.orDie),
  });
});

export const layer = Layer.effect(ElectronMenu, make);
