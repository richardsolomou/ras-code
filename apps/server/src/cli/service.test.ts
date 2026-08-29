import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as BootService from "../cloud/bootService.ts";
import { formatServiceStatus, offerServiceDuringOnboarding } from "./service.ts";

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/ras-code.service",
  logPath: "/home/me/.ras-code/userdata/logs/boot-service.log",
} as const;

it("reports the installed service version and host paths", () => {
  assert.equal(
    formatServiceStatus(status, "0.0.29"),
    [
      "RAS Code service",
      "  Status: installed · ras-code@0.0.29",
      "  Unit: /home/me/.config/systemd/user/ras-code.service",
      "  Logs: /home/me/.ras-code/userdata/logs/boot-service.log",
    ].join("\n"),
  );
});

it("gives a direct repair command for a stale service", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29"),
    "Next: Run `npx ras-code@latest service update`.",
  );
});

it("explains where the service is supported", () => {
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, "0.0.29"),
    "Supported on: Linux with systemd, macOS with launchd",
  );
});

it.effect("restarts an installed service so it picks up the desired link", () =>
  Effect.gen(function* () {
    // The running server read the desired link at startup, before `connect`
    // wrote it, so without a restart the link is never provisioned.
    const restarts = yield* Ref.make(0);
    const service = BootService.BootService.of({
      install: Effect.die("unused"),
      uninstall: Effect.die("unused"),
      restart: Ref.update(restarts, (count) => count + 1).pipe(Effect.as(true)),
      status: Effect.succeed({ ...status, supported: true, installed: true, current: true }),
    });

    const handled = yield* offerServiceDuringOnboarding.pipe(
      Effect.provideService(BootService.BootService, service),
      Effect.provide(NodeServices.layer),
    );

    assert.isTrue(handled);
    assert.equal(yield* Ref.get(restarts), 1);
  }),
);
