// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import {
  deploymentForStage,
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
        notFoundHandling: "single-page-application",
        // Assets are served before the Worker, so the router never sees a
        // request whose path exactly matches a built file — including `/`.
        // Alchemy does not currently forward this to Cloudflare (deployed
        // config reports `raw_run_worker_first: false`), so channel switching
        // works on app routes but not on `/`. See docs/operations/release.md.
        runWorkerFirst: runsChannelRouter(deployment),
      },
      env: webWorkerEnv(deployment, domains),
    });

    return {
      stage,
      workerName: site.workerName,
      url: site.url,
      domain,
    };
  }),
);
