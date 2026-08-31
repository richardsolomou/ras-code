import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  deploymentForStage,
  routerHostname,
  runsChannelRouter,
  hostedAppRoutePatterns,
  webWorkerDomain,
  servesOnWorkersDev,
  webWorkerEnv,
  webWorkerName,
  previewUrl,
  type WebDeployment,
} from "./deployment.ts";

const DOMAINS = {
  routerHost: "code.ras.sh",
  canaryDomain: "code-canary.ras.sh",
};

const LATEST: WebDeployment = { kind: "channel", channel: "latest" };
const CANARY: WebDeployment = { kind: "channel", channel: "canary" };
const PREVIEW: WebDeployment = { kind: "preview", pullRequest: 329 };

describe("deploymentForStage", () => {
  it.effect("maps the two release channels", () =>
    Effect.gen(function* () {
      expect(yield* deploymentForStage("latest")).toEqual(LATEST);
      expect(yield* deploymentForStage("canary")).toEqual(CANARY);
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
  it("leaves the router domain to the marketing site, reaching latest by route", () => {
    expect(webWorkerDomain(LATEST, DOMAINS)).toBeUndefined();
  });

  it("gives canary only its own channel domain", () => {
    expect(webWorkerDomain(CANARY, DOMAINS)).toEqual({ name: "code-canary.ras.sh" });
  });

  it("gives a preview no domain, so it cannot take one from a channel", () => {
    expect(webWorkerDomain(PREVIEW, DOMAINS)).toBeUndefined();
  });
});

describe("hostedAppRoutePatterns", () => {
  it("claims the bare prefix as well as everything under it", () => {
    expect(hostedAppRoutePatterns("code.ras.sh")).toContain("code.ras.sh/app");
    expect(hostedAppRoutePatterns("code.ras.sh")).toContain("code.ras.sh/app/*");
  });

  it("keeps the legacy entry points shipped clients still address", () => {
    expect(hostedAppRoutePatterns("code.ras.sh")).toEqual(
      expect.arrayContaining([
        "code.ras.sh/pair*",
        "code.ras.sh/connect*",
        "code.ras.sh/__ras-code/*",
      ]),
    );
  });

  it("matches legacy entry points carrying a query, which pairing links always do", () => {
    for (const pattern of hostedAppRoutePatterns("code.ras.sh")) {
      if (pattern.startsWith("code.ras.sh/pair")) {
        expect(pattern.endsWith("*")).toBe(true);
      }
    }
  });

  it("claims nothing the marketing site serves", () => {
    expect(hostedAppRoutePatterns("code.ras.sh")).not.toContain("code.ras.sh/*");
  });
});

describe("servesOnWorkersDev", () => {
  it("exposes previews on workers.dev, since they have no other address", () => {
    expect(servesOnWorkersDev(PREVIEW)).toBe(true);
  });

  it("keeps release channels off workers.dev", () => {
    expect(servesOnWorkersDev(LATEST)).toBe(false);
    expect(servesOnWorkersDev(CANARY)).toBe(false);
  });
});

describe("webWorkerEnv", () => {
  it("gives the latest channel the router configuration", () => {
    expect(webWorkerEnv(LATEST, DOMAINS)).toEqual({
      RAS_CODE_WEB_ROUTER_HOST: "code.ras.sh",
      RAS_CODE_WEB_CANARY_ORIGIN: "https://code-canary.ras.sh",
    });
  });

  it("leaves the canary channel unable to route", () => {
    expect(webWorkerEnv(CANARY, DOMAINS)).toEqual({});
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

  it("does not route on canary or a preview, which serve their own assets", () => {
    expect(runsChannelRouter(CANARY)).toBe(false);
    expect(runsChannelRouter(PREVIEW)).toBe(false);
  });
});
