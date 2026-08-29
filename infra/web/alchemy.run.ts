// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import {
  brandAssetChannel,
  deploymentForStage,
  routerHostname,
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
    const latestDomain = yield* Config.nonEmptyString("RAS_CODE_WEB_LATEST_DOMAIN");
    const nightlyDomain = yield* Config.nonEmptyString("RAS_CODE_WEB_NIGHTLY_DOMAIN");
    const routerHost = yield* routerHostname(routerUrl).pipe(Effect.orDie);

    const domains = { routerHost, latestDomain, nightlyDomain };
    const domain = webWorkerDomain(deployment, domains);

    const site = yield* Cloudflare.Website.StaticSite("ras-code-web", {
      name: webWorkerName(stage),
      cwd: "../..",
      command: `vp run --filter @ras-code/web build && node scripts/apply-web-brand-assets.ts --channel ${brandAssetChannel(deployment)}`,
      outdir: "apps/web/dist",
      main: "../../apps/web/worker.ts",
      ...(domain ? { domain } : {}),
      // Previews are reachable only here, so the generated URL is their address.
      workersDev: servesOnWorkersDev(deployment),
      assets: {
        notFoundHandling: "single-page-application",
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
