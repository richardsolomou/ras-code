import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  deploymentForStage,
  routerHostname,
  runsChannelRouter,
  webWorkerDomain,
  servesOnWorkersDev,
  webWorkerEnv,
  webWorkerName,
  previewUrl,
  type WebDeployment,
} from "./deployment.ts";

const DOMAINS = {
  routerHost: "code.ras.sh",
  latestDomain: "code-latest.ras.sh",
  nightlyDomain: "code-nightly.ras.sh",
};

const LATEST: WebDeployment = { kind: "channel", channel: "latest" };
const NIGHTLY: WebDeployment = { kind: "channel", channel: "nightly" };
const PREVIEW: WebDeployment = { kind: "preview", pullRequest: 329 };

describe("deploymentForStage", () => {
  it.effect("maps the two release channels", () =>
    Effect.gen(function* () {
      expect(yield* deploymentForStage("latest")).toEqual(LATEST);
      expect(yield* deploymentForStage("nightly")).toEqual(NIGHTLY);
    }),
  );

  it.effect("maps a pull request stage to a preview", () =>
    Effect.gen(function* () {
      expect(yield* deploymentForStage("pr-329")).toEqual(PREVIEW);
    }),
  );

  it.effect("refuses a stage that names nothing deployable", () =>
    Effect.gen(function* () {
      const error = yield* deploymentForStage("prod").pipe(Effect.flip);
      expect(error.stage).toBe("prod");
    }),
  );

  it.effect("refuses a preview stage without a pull request number", () =>
    Effect.gen(function* () {
      expect(yield* deploymentForStage("pr-").pipe(Effect.flip)).toBeDefined();
      expect(yield* deploymentForStage("pr-abc").pipe(Effect.flip)).toBeDefined();
    }),
  );
});

describe("webWorkerDomain", () => {
  it("serves latest on its channel domain with the router domain aliased to it", () => {
    expect(webWorkerDomain(LATEST, DOMAINS)).toEqual({
      name: "code-latest.ras.sh",
      aliases: ["code.ras.sh"],
    });
  });

  it("gives nightly only its own channel domain", () => {
    expect(webWorkerDomain(NIGHTLY, DOMAINS)).toEqual({ name: "code-nightly.ras.sh" });
  });

  it("gives a preview no domain, so it cannot take one from a channel", () => {
    expect(webWorkerDomain(PREVIEW, DOMAINS)).toBeUndefined();
  });
});

describe("servesOnWorkersDev", () => {
  it("exposes previews on workers.dev, since they have no other address", () => {
    expect(servesOnWorkersDev(PREVIEW)).toBe(true);
  });

  it("keeps release channels off workers.dev", () => {
    expect(servesOnWorkersDev(LATEST)).toBe(false);
    expect(servesOnWorkersDev(NIGHTLY)).toBe(false);
  });
});

describe("webWorkerEnv", () => {
  it("gives the latest channel the router configuration", () => {
    expect(webWorkerEnv(LATEST, DOMAINS)).toEqual({
      RAS_CODE_WEB_ROUTER_HOST: "code.ras.sh",
      RAS_CODE_WEB_NIGHTLY_ORIGIN: "https://code-nightly.ras.sh",
    });
  });

  it("leaves the nightly channel unable to route", () => {
    expect(webWorkerEnv(NIGHTLY, DOMAINS)).toEqual({});
  });

  it("leaves a preview unable to route", () => {
    expect(webWorkerEnv(PREVIEW, DOMAINS)).toEqual({});
  });
});

describe("routerHostname", () => {
  it.effect("takes the hostname from the router URL", () =>
    Effect.gen(function* () {
      expect(yield* routerHostname("https://code.ras.sh/app")).toBe("code.ras.sh");
    }),
  );

  it.effect("refuses a value that is not an absolute URL", () =>
    Effect.gen(function* () {
      const error = yield* routerHostname("code.ras.sh").pipe(Effect.flip);
      expect(error.routerUrl).toBe("code.ras.sh");
    }),
  );
});

describe("webWorkerName", () => {
  it("names the worker after its stage so the name is predictable", () => {
    expect(webWorkerName("pr-329")).toBe("ras-code-web-pr-329");
    expect(webWorkerName("latest")).toBe("ras-code-web-latest");
  });
});

describe("previewUrl", () => {
  it("builds the workers.dev origin baked into a preview build", () => {
    expect(previewUrl("pr-329", "tronite")).toBe("https://ras-code-web-pr-329.tronite.workers.dev");
  });
});

describe("runsChannelRouter", () => {
  it("routes only on the latest channel, which owns the router domain", () => {
    expect(runsChannelRouter(LATEST)).toBe(true);
  });

  it("does not route on nightly or a preview, which serve their own assets", () => {
    expect(runsChannelRouter(NIGHTLY)).toBe(false);
    expect(runsChannelRouter(PREVIEW)).toBe(false);
  });
});
