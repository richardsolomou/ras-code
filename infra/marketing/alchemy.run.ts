// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export default Alchemy.Stack(
  "RasCodeMarketing",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const domain = yield* Config.nonEmptyString("RAS_CODE_MARKETING_DOMAIN").pipe(Config.option);

    // No `main`: with no Worker entry, Alchemy serves every request straight
    // from the assets binding, which is all a fully static Astro build needs.
    const site = yield* Cloudflare.Website.StaticSite("ras-code-marketing", {
      name: `ras-code-marketing-${stage}`,
      cwd: "../..",
      command: "vp run --filter @ras-code/marketing build",
      outdir: "apps/marketing/dist",
      ...(Option.isSome(domain) ? { domain: domain.value } : {}),
      // Without a custom domain the generated URL is the only way in.
      url: Option.isNone(domain),
      assets: {
        notFoundHandling: "404-page",
      },
    });

    return {
      workerName: site.workerName,
      url: site.url,
      domain: Option.getOrUndefined(domain),
    };
  }),
);
