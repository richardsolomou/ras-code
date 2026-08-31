// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import { HOSTED_APP_BASE_PATH } from "@ras-code/shared/connectAuth";
import {
  deploymentForStage,
  hostedAppRoutePatterns,
  routerHostname,
  runsChannelRouter,
  webWorkerDomain,
  servesOnWorkersDev,
  webWorkerEnv,
  webWorkerName,
} from "./src/deployment.ts";

export default Alchemy.Stack(
  "RasCodeWeb",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const deployment = yield* deploymentForStage(stage).pipe(Effect.orDie);

    const routerUrl = yield* Config.nonEmptyString("RAS_CODE_WEB_ROUTER_URL");
    const canaryDomain = yield* Config.nonEmptyString("RAS_CODE_WEB_CANARY_DOMAIN");
    const routerHost = yield* routerHostname(routerUrl).pipe(Effect.orDie);

    const domains = { routerHost, canaryDomain };
    const domain = webWorkerDomain(deployment, domains);

    // StaticSite execs the build without a shell, so the prefix the hosted
    // bundle is served under reaches Vite through the environment.
    process.env.VITE_APP_BASE = HOSTED_APP_BASE_PATH;

    const site = yield* Cloudflare.Website.StaticSite("ras-code-web", {
      name: webWorkerName(stage),
      cwd: "../..",
      // A package script, because StaticSite execs the command without a shell:
      // chaining here would send the second command's flags to the first.
      // `build:hosted` brands the output from VITE_HOSTED_APP_CHANNEL, which
      // defaults to latest for previews.
      command: "vp run --filter @ras-code/web build:hosted",
      outdir: "apps/web/dist",
      main: "../../apps/web/worker.ts",
      ...(domain ? { domain } : {}),
      // Previews are reachable only here, so the generated URL is their address.
      workersDev: servesOnWorkersDev(deployment),
      assets: {
        // The build sits under the app's path prefix, so Cloudflare's own
        // single-page fallback (which serves `/index.html`) would find
        // nothing. `none` hands every miss to the Worker instead, which
        // serves the shell for app routes and redirects the legacy root
        // entry points.
        notFoundHandling: "none",
        // The Worker serves the shell by asking the asset layer for
        // `<base>index.html`. Under the default handling that request is
        // answered with a redirect back to `<base>`, which the Worker returns
        // and the browser follows straight back into the Worker — a loop.
        // Serving the file as named breaks it.
        htmlHandling: "none",
        // Assets are served before the Worker, so the router never sees a
        // request whose path exactly matches a built file. Alchemy does not
        // currently forward this to Cloudflare (deployed config reports
        // `raw_run_worker_first: false`), so channel switching works on app
        // routes but not on the app's own index. See docs/operations/release.md.
        runWorkerFirst: runsChannelRouter(deployment),
      },
      env: webWorkerEnv(deployment, domains),
    });

    // Only the stable channel shares a hostname with the marketing site, so
    // only it needs routes; canary and previews answer on their own address.
    if (runsChannelRouter(deployment)) {
      const zoneId = yield* Config.nonEmptyString("RAS_CODE_WEB_ZONE_ID");
      yield* Effect.forEach(
        hostedAppRoutePatterns(routerHost),
        (pattern) =>
          Cloudflare.Workers.WorkerRoute(
            `ras-code-web-route-${pattern.replaceAll(/[^a-z0-9]+/gi, "-")}`,
            { zoneId, pattern, script: site.workerName },
          ),
        { discard: true },
      );
    }

    return {
      stage,
      workerName: site.workerName,
      url: site.url,
      domain,
    };
  }),
);
