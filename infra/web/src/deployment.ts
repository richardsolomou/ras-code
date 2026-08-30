import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export const WEB_CHANNELS = ["latest", "canary"] as const;

export type WebChannel = (typeof WEB_CHANNELS)[number];

const PREVIEW_STAGE = /^pr-(\d+)$/;

/**
 * Worker names are set explicitly rather than generated, because a preview's
 * `workers.dev` URL has to be known before the build that bakes it in.
 * `.github/workflows/web-preview.yml` derives the same name.
 */
const WORKER_NAME_PREFIX = "ras-code-web";

/**
 * A release channel serves a fixed domain; a preview serves only its generated
 * `workers.dev` URL and is destroyed when its pull request closes.
 */
export type WebDeployment =
  | { readonly kind: "channel"; readonly channel: WebChannel }
  | { readonly kind: "preview"; readonly pullRequest: number };

export class UnknownWebStageError extends Data.TaggedError("UnknownWebStageError")<{
  readonly stage: string;
}> {
  override get message(): string {
    return `The hosted web app deploys to stage 'latest', 'canary', or 'pr-<number>', got '${this.stage}'.`;
  }
}

export class InvalidRouterUrlError extends Data.TaggedError("InvalidRouterUrlError")<{
  readonly routerUrl: string;
}> {
  override get message(): string {
    return `RAS_CODE_WEB_ROUTER_URL must be an absolute URL, got '${this.routerUrl}'.`;
  }
}

/**
 * The deployment stage names what is being published, so a stage typo cannot
 * quietly publish canary or preview assets onto the stable domain.
 */
export function deploymentForStage(
  stage: string,
): Effect.Effect<WebDeployment, UnknownWebStageError> {
  if (stage === "latest" || stage === "canary") {
    return Effect.succeed({ kind: "channel", channel: stage });
  }
  const preview = PREVIEW_STAGE.exec(stage);
  if (preview) {
    return Effect.succeed({ kind: "preview", pullRequest: Number(preview[1]) });
  }
  return Effect.fail(new UnknownWebStageError({ stage }));
}

export function routerHostname(routerUrl: string): Effect.Effect<string, InvalidRouterUrlError> {
  return Effect.try({
    try: () => new URL(routerUrl).hostname,
    catch: () => new InvalidRouterUrlError({ routerUrl }),
  }).pipe(
    Effect.filterOrFail(
      (hostname) => hostname.length > 0,
      () => new InvalidRouterUrlError({ routerUrl }),
    ),
  );
}

export interface WebDomains {
  readonly routerHost: string;
  readonly canaryDomain: string;
}

export interface WebWorkerDomain {
  readonly name: string;
}

/**
 * Previews get no custom domain. Attaching one would take it from whichever
 * channel currently owns it, so previews are reachable only at their
 * `workers.dev` URL. Canary has to be separately addressable because the
 * router proxies to it; stable shares the router domain with the marketing
 * site, which owns it as a custom domain, so stable is reached through the
 * path routes below instead.
 */
export function webWorkerDomain(
  deployment: WebDeployment,
  domains: WebDomains,
): WebWorkerDomain | undefined {
  if (deployment.kind === "preview" || deployment.channel === "latest") {
    return undefined;
  }
  return { name: domains.canaryDomain };
}

/**
 * Path patterns the app answers on the shared router host. Cloudflare matches
 * patterns literally, so the prefix needs both forms: `/app/*` alone would
 * miss `/app` itself. The trailing three are entry points shipped clients
 * still address at the root, which the Worker redirects under the prefix.
 */
export function hostedAppRoutePatterns(routerHost: string): ReadonlyArray<string> {
  return [
    `${routerHost}/app`,
    `${routerHost}/app/*`,
    `${routerHost}/pair`,
    `${routerHost}/connect`,
    `${routerHost}/connect/*`,
    `${routerHost}/__ras-code/*`,
  ];
}

/** Only previews are reached over workers.dev; channels use their own domains. */
export function servesOnWorkersDev(deployment: WebDeployment): boolean {
  return deployment.kind === "preview";
}

/**
 * Only the latest channel answers on the router domain, so only it has to
 * inspect requests. The others serve their own assets unconditionally.
 */
export function runsChannelRouter(deployment: WebDeployment): boolean {
  return deployment.kind === "channel" && deployment.channel === "latest";
}

/**
 * Only the router receives the routing configuration. Without these the Worker
 * serves its own assets unconditionally, which is what both the canary channel
 * and a preview should do.
 */
export function webWorkerEnv(
  deployment: WebDeployment,
  domains: WebDomains,
): Record<string, string> {
  return runsChannelRouter(deployment)
    ? {
        RAS_CODE_WEB_ROUTER_HOST: domains.routerHost,
        RAS_CODE_WEB_CANARY_ORIGIN: `https://${domains.canaryDomain}`,
      }
    : {};
}

export function webWorkerName(stage: string): string {
  return `${WORKER_NAME_PREFIX}-${stage}`;
}

export function previewUrl(stage: string, workersSubdomain: string): string {
  return `https://${webWorkerName(stage)}.${workersSubdomain}.workers.dev`;
}
