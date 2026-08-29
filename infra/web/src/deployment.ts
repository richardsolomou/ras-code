import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export const WEB_CHANNELS = ["latest", "nightly"] as const;

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
    return `The hosted web app deploys to stage 'latest', 'nightly', or 'pr-<number>', got '${this.stage}'.`;
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
 * quietly publish nightly or preview assets onto the stable domain.
 */
export function deploymentForStage(
  stage: string,
): Effect.Effect<WebDeployment, UnknownWebStageError> {
  if (stage === "latest" || stage === "nightly") {
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
  readonly latestDomain: string;
  readonly nightlyDomain: string;
}

export interface WebWorkerDomain {
  readonly name: string;
  readonly aliases?: string[];
}

/**
 * Previews get no custom domain. Attaching one would take it from whichever
 * channel currently owns it, so previews are reachable only at their
 * `workers.dev` URL. The router domain is an alias of the latest channel's own
 * domain, which is how the hosted app has always been addressed.
 */
export function webWorkerDomain(
  deployment: WebDeployment,
  domains: WebDomains,
): WebWorkerDomain | undefined {
  if (deployment.kind === "preview") {
    return undefined;
  }
  return deployment.channel === "latest"
    ? { name: domains.latestDomain, aliases: [domains.routerHost] }
    : { name: domains.nightlyDomain };
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
 * serves its own assets unconditionally, which is what both the nightly channel
 * and a preview should do.
 */
export function webWorkerEnv(
  deployment: WebDeployment,
  domains: WebDomains,
): Record<string, string> {
  return runsChannelRouter(deployment)
    ? {
        RAS_CODE_WEB_ROUTER_HOST: domains.routerHost,
        RAS_CODE_WEB_NIGHTLY_ORIGIN: `https://${domains.nightlyDomain}`,
      }
    : {};
}

export function webWorkerName(stage: string): string {
  return `${WORKER_NAME_PREFIX}-${stage}`;
}

export function previewUrl(stage: string, workersSubdomain: string): string {
  return `https://${webWorkerName(stage)}.${workersSubdomain}.workers.dev`;
}
