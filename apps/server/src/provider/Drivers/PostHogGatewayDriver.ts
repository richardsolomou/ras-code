import * as NodeOS from "node:os";

/**
 * PostHogGatewayDriver — one provider, two harnesses.
 *
 * The PostHog AI Gateway serves its whole catalog from one origin, but on two
 * request shapes: `claude-*` ids exist only on Anthropic Messages, everything
 * else only on Responses (see `@ras-code/shared/posthogGateway`). Neither
 * shipped harness speaks both, so this driver creates a Claude child and a
 * Codex child in its own scope, points both at the gateway, and routes every
 * call by `gatewayModelShape(model)`. The user picks a model; the driver picks
 * the harness.
 *
 * The children are internal. Their instance ids never reach settings, the
 * registry, or the wire — the composite rewrites the instance id and driver
 * kind on every session and runtime event it passes through, because
 * `ProviderService.correlateRuntimeEventWithInstance` rejects an event whose
 * driver kind is not the one the registry has bound to that instance.
 *
 * Continuation: the composite inherits the Claude child's continuation key
 * (`claude:home:<resolved home>`), so a plain Claude instance sharing the same
 * config dir can hand a started thread to this driver mid-conversation.
 * Open-model routing has no such resume state, so those fallbacks apply to new
 * threads only.
 *
 * @module provider/Drivers/PostHogGatewayDriver
 */
import {
  ClaudeSettings,
  CodexSettings,
  DEFAULT_MODEL_BY_PROVIDER,
  PostHogGatewaySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceEnvironment,
  type ProviderRemoteModel,
  type ModelSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUsageLimit,
  type ServerProvider,
  type ServerProviderModel,
  type ThreadId,
} from "@ras-code/contracts";
import {
  ANTHROPIC_API_KEY_VARIABLE,
  ANTHROPIC_AUTH_TOKEN_VARIABLE,
  ANTHROPIC_BASE_URL_VARIABLE,
  gatewayBaseUrl,
  gatewayKey,
  gatewayModelShape,
  posthogGatewayCodexLaunchArgs,
  POSTHOG_GATEWAY_BASE_URL,
  RAS_GATEWAY_KEY_VARIABLE,
  type GatewayModelShape,
} from "@ras-code/shared/posthogGateway";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import {
  ProviderAdapterRequestError,
  ProviderDriverError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "./ClaudeDriver.ts";
import { createCodexInstance, type CodexDriverEnv } from "./CodexDriver.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { fetchGatewayModels } from "../remoteModels.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";

const DRIVER_KIND = ProviderDriverKind.make("posthogGateway");
const DISPLAY_NAME = "PostHog AI Gateway";
const CATALOG_REFRESH_INTERVAL = Duration.minutes(5);
export function postHogGatewayBaseInstructions(): string {
  return "You are a coding agent running in RAS Code. You and the user share one workspace. Your job is to collaborate with the user until you complete the user's goal. The active model identifier is provided in each turn's developer instructions and may change between turns. If the user asks which model you are, answer with that exact identifier. Do not replace it with a model family or provider name, and do not claim that it is unavailable.";
}

const decodePostHogGatewaySettings = Schema.decodeSync(PostHogGatewaySettings);
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

export type PostHogGatewayDriverEnv = ClaudeDriverEnv | CodexDriverEnv | HttpClient.HttpClient;

/** Message shown when the instance cannot reach the gateway at all. */
const MISSING_KEY_MESSAGE = `Set ${RAS_GATEWAY_KEY_VARIABLE} on this instance to use the PostHog AI Gateway.`;
export const CROSS_SHAPE_SWITCH_MESSAGE =
  "Start a new thread to switch between Claude and open models on PostHog AI Gateway.";

/**
 * The gateway origin for this instance. Config wins over the environment so
 * an instance migrated from the old Claude-driver preset (which wrote
 * `ANTHROPIC_BASE_URL`) keeps working without an edit.
 */
export function resolveGatewayBaseUrl(input: {
  readonly configuredBaseUrl: string;
  readonly environment: ProviderInstanceEnvironment;
}): string {
  const configured = input.configuredBaseUrl.trim();
  if (configured.length > 0) return configured;
  const fromEnvironment = gatewayBaseUrl(input.environment);
  return fromEnvironment.length > 0 ? fromEnvironment : POSTHOG_GATEWAY_BASE_URL;
}

const upsertVariable = (
  environment: ReadonlyArray<ProviderInstanceEnvironment[number]>,
  variable: ProviderInstanceEnvironment[number],
): ReadonlyArray<ProviderInstanceEnvironment[number]> => [
  ...environment.filter((entry) => entry.name !== variable.name),
  variable,
];

/**
 * Environment for the Claude child: the instance's own variables plus the
 * Anthropic-shaped gateway coordinates. `ANTHROPIC_API_KEY` is written empty
 * so a key exported in the user's shell cannot outrank the gateway token.
 */
export function buildClaudeChildEnvironment(input: {
  readonly environment: ProviderInstanceEnvironment;
  readonly baseUrl: string;
  readonly key: string;
}): ProviderInstanceEnvironment {
  let next: ReadonlyArray<ProviderInstanceEnvironment[number]> = input.environment;
  next = upsertVariable(next, {
    name: ANTHROPIC_BASE_URL_VARIABLE,
    value: input.baseUrl,
    sensitive: false,
  });
  next = upsertVariable(next, {
    name: ANTHROPIC_AUTH_TOKEN_VARIABLE,
    value: input.key,
    sensitive: true,
  });
  next = upsertVariable(next, {
    name: ANTHROPIC_API_KEY_VARIABLE,
    value: "",
    sensitive: false,
  });
  return next as ProviderInstanceEnvironment;
}

/**
 * Environment for the Codex child. Codex reads the key through the
 * `env_key` its launch args name, so the value has to be present under
 * `RAS_GATEWAY_KEY` whichever variable the user actually wrote it in.
 */
export function buildCodexChildEnvironment(input: {
  readonly environment: ProviderInstanceEnvironment;
  readonly key: string;
}): ProviderInstanceEnvironment {
  return upsertVariable(input.environment, {
    name: RAS_GATEWAY_KEY_VARIABLE,
    value: input.key,
    sensitive: true,
  }) as ProviderInstanceEnvironment;
}

const childInstanceId = (instanceId: ProviderInstanceId, suffix: string): ProviderInstanceId =>
  ProviderInstanceId.make(`${instanceId}_${suffix}`);

/** Model capabilities are keyed by full slug and by the id's last segment. */
const indexModelsBySlug = (
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyMap<string, ServerProviderModel> => {
  const index = new Map<string, ServerProviderModel>();
  for (const model of models) {
    index.set(model.slug, model);
    const bare = model.slug.slice(model.slug.lastIndexOf("/") + 1);
    if (!index.has(bare)) index.set(bare, model);
  }
  return index;
};

const bareSlug = (id: string): string => id.slice(id.lastIndexOf("/") + 1);

/**
 * Turn the gateway catalog into provider models, taking each model's
 * capabilities from the child that will serve it. Open-weight ids match no
 * harness catalog and carry `capabilities: null`, which the UI renders as
 * "no options".
 */
export function buildGatewayModels(input: {
  readonly catalog: ReadonlyArray<ProviderRemoteModel>;
  readonly claudeModels: ReadonlyArray<ServerProviderModel>;
  readonly codexModels: ReadonlyArray<ServerProviderModel>;
  readonly defaultModel: string;
}): ReadonlyArray<ServerProviderModel> {
  const claudeIndex = indexModelsBySlug(input.claudeModels);
  const codexIndex = indexModelsBySlug(input.codexModels);
  return input.catalog.map((entry) => {
    const shape = gatewayModelShape(entry.id);
    const donor =
      shape === "anthropic"
        ? (claudeIndex.get(entry.id) ?? claudeIndex.get(bareSlug(entry.id)))
        : (codexIndex.get(entry.id) ?? codexIndex.get(bareSlug(entry.id)));
    return {
      slug: entry.id,
      name: entry.name ?? entry.id,
      isCustom: false,
      ...(entry.id === input.defaultModel ? { isDefault: true } : {}),
      capabilities: donor?.capabilities ?? null,
    } satisfies ServerProviderModel;
  });
}

const USAGE_LIMIT_SEVERITY: Record<ProviderUsageLimit["status"], number> = {
  ok: 0,
  warning: 1,
  exhausted: 2,
};

/**
 * The composite reports the worst limit either harness has seen. A gateway
 * instance is often someone's fallback target, but it can be a primary too,
 * and a primary that never reports exhaustion never fails over.
 */
export function mergeUsageLimits(
  left: ProviderUsageLimit | null | undefined,
  right: ProviderUsageLimit | null | undefined,
): ProviderUsageLimit | null {
  if (!left) return right ?? null;
  if (!right) return left;
  return USAGE_LIMIT_SEVERITY[right.status] > USAGE_LIMIT_SEVERITY[left.status] ? right : left;
}

/**
 * Compose one snapshot from the two children and the gateway catalog.
 *
 * "Ready" means the harness needed for at least one catalog model is ready:
 * a missing Codex install must not hide the Claude half of the catalog, and
 * vice versa. With no catalog yet, both children count.
 */
export function composeGatewaySnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly enabled: boolean;
  readonly continuationGroupKey: string;
  readonly claude: ServerProvider;
  readonly codex: ServerProvider;
  readonly catalog: ReadonlyArray<ProviderRemoteModel>;
  readonly defaultModel: string;
  readonly hasKey: boolean;
  readonly baseUrl: string;
}): ServerProvider {
  const shapes = new Set<GatewayModelShape>(
    input.catalog.length === 0
      ? (["anthropic", "openai"] as const)
      : input.catalog.map((model) => gatewayModelShape(model.id)),
  );
  const needed = [
    ...(shapes.has("anthropic") ? [input.claude] : []),
    ...(shapes.has("openai") ? [input.codex] : []),
  ];
  const status: ServerProvider["status"] = !input.enabled
    ? "disabled"
    : !input.hasKey
      ? "error"
      : needed.some((child) => child.status === "ready")
        ? "ready"
        : needed.some((child) => child.status === "warning")
          ? "warning"
          : "error";
  const unreadyChild = needed.find((child) => child.status !== "ready");
  const message = !input.hasKey
    ? MISSING_KEY_MESSAGE
    : status === "ready" || unreadyChild?.message === undefined
      ? undefined
      : unreadyChild.message;
  const checkedAt =
    input.claude.checkedAt > input.codex.checkedAt ? input.claude.checkedAt : input.codex.checkedAt;
  const usageLimit = mergeUsageLimits(input.claude.usageLimit, input.codex.usageLimit);

  return {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    displayName: input.displayName ?? DISPLAY_NAME,
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
    requiresNewThreadForModelChange: false,
    enabled: input.enabled,
    installed: input.claude.installed || input.codex.installed,
    version: null,
    status,
    auth: input.hasKey
      ? {
          status: "authenticated" as const,
          type: "api-key",
          label: `Gateway key (${input.baseUrl})`,
        }
      : { status: "unauthenticated" as const },
    checkedAt,
    ...(message ? { message } : {}),
    availability: "available",
    models: buildGatewayModels({
      catalog: input.catalog,
      claudeModels: input.claude.models,
      codexModels: input.codex.models,
      defaultModel: input.defaultModel,
    }),
    // Slash commands and skills come from the shared Claude config dir; the
    // Codex harness contributes none through this path.
    slashCommands: input.claude.slashCommands,
    skills: input.claude.skills,
    ...(usageLimit ? { usageLimit } : {}),
  } satisfies ServerProvider;
}

interface ChildAdapters {
  readonly anthropic: ProviderAdapterShape<ProviderAdapterError>;
  readonly openai: ProviderAdapterShape<ProviderAdapterError>;
}

/**
 * Route every adapter call to the harness that can serve it.
 *
 * A thread's shape is recorded on `startSession` and kept for the rest of the
 * conversation. A turn that asks for a model on the other shape is refused
 * rather than silently restarted on the other harness: the two harnesses have
 * no shared resume state, so continuing would drop the conversation.
 */
export function makeGatewayAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly children: ChildAdapters;
  readonly childInstanceIds: Readonly<Record<GatewayModelShape, ProviderInstanceId>>;
}): ProviderAdapterShape<ProviderAdapterError> {
  const { instanceId, children, childInstanceIds } = input;
  const routes = new Map<ThreadId, GatewayModelShape>();
  const childFor = (shape: GatewayModelShape) => children[shape];

  // Children validate the inbound provider kind and only honour a model whose
  // selection names their own instance, so both are translated on the way in.
  const forChild = <
    T extends {
      readonly provider?: ProviderDriverKind | undefined;
      readonly modelSelection?: ModelSelection | undefined;
    },
  >(
    shape: GatewayModelShape,
    call: T,
  ): T => ({
    ...call,
    provider: childFor(shape).provider,
    ...(call.modelSelection
      ? { modelSelection: { ...call.modelSelection, instanceId: childInstanceIds[shape] } }
      : {}),
  });

  const crossShapeError = (method: string) =>
    new ProviderAdapterRequestError({
      provider: DRIVER_KIND,
      method,
      detail: CROSS_SHAPE_SWITCH_MESSAGE,
    });

  const stampSession = (session: ProviderSession): ProviderSession => ({
    ...session,
    provider: DRIVER_KIND,
    providerInstanceId: instanceId,
  });

  const stampEvent = (event: ProviderRuntimeEvent): ProviderRuntimeEvent => ({
    ...event,
    provider: DRIVER_KIND,
    providerInstanceId: instanceId,
  });

  /**
   * The harness that owns `threadId`. A recorded route wins; otherwise the
   * requested model decides; otherwise we ask both children who holds the
   * session. Falls back to the Anthropic harness so a call on an unknown
   * thread still produces that harness's own not-found error.
   */
  const resolveShape = (input: {
    readonly threadId: ThreadId;
    readonly model?: string | undefined;
    readonly method: string;
  }): Effect.Effect<GatewayModelShape, ProviderAdapterError> =>
    Effect.gen(function* () {
      const recorded = routes.get(input.threadId);
      const requested = input.model === undefined ? undefined : gatewayModelShape(input.model);
      if (recorded !== undefined) {
        if (requested !== undefined && requested !== recorded) {
          return yield* crossShapeError(input.method);
        }
        return recorded;
      }
      if (requested !== undefined) {
        return requested;
      }
      const ownedByAnthropic = yield* children.anthropic.hasSession(input.threadId);
      if (ownedByAnthropic) return "anthropic" as const;
      const ownedByOpenai = yield* children.openai.hasSession(input.threadId);
      return ownedByOpenai ? ("openai" as const) : ("anthropic" as const);
    });
  const resolveChild = (input: {
    readonly threadId: ThreadId;
    readonly model?: string | undefined;
    readonly method: string;
  }) => resolveShape(input).pipe(Effect.map(childFor));

  return {
    provider: DRIVER_KIND,
    // Both harnesses switch models in place. Crossing the shape boundary is
    // refused in `sendTurn`, which is where the requested model arrives.
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (sessionInput) =>
      Effect.gen(function* () {
        const shape = gatewayModelShape(sessionInput.modelSelection?.model ?? "");
        const session = yield* childFor(shape).startSession(forChild(shape, sessionInput));
        routes.set(sessionInput.threadId, shape);
        return stampSession(session);
      }),
    sendTurn: (turnInput) =>
      resolveShape({
        threadId: turnInput.threadId,
        model: turnInput.modelSelection?.model,
        method: "sendTurn",
      }).pipe(Effect.flatMap((shape) => childFor(shape).sendTurn(forChild(shape, turnInput)))),
    interruptTurn: (threadId, turnId) =>
      resolveChild({ threadId, method: "interruptTurn" }).pipe(
        Effect.flatMap((child) => child.interruptTurn(threadId, turnId)),
      ),
    respondToRequest: (threadId, requestId, decision) =>
      resolveChild({ threadId, method: "respondToRequest" }).pipe(
        Effect.flatMap((child) => child.respondToRequest(threadId, requestId, decision)),
      ),
    respondToUserInput: (threadId, requestId, answers) =>
      resolveChild({ threadId, method: "respondToUserInput" }).pipe(
        Effect.flatMap((child) => child.respondToUserInput(threadId, requestId, answers)),
      ),
    stopSession: (threadId) =>
      resolveChild({ threadId, method: "stopSession" }).pipe(
        Effect.flatMap((child) => child.stopSession(threadId)),
        Effect.tap(() => Effect.sync(() => routes.delete(threadId))),
      ),
    listSessions: () =>
      Effect.zipWith(
        children.anthropic.listSessions(),
        children.openai.listSessions(),
        (left, right) => [...left, ...right].map(stampSession),
      ),
    hasSession: (threadId) =>
      children.anthropic
        .hasSession(threadId)
        .pipe(
          Effect.flatMap((owned) =>
            owned ? Effect.succeed(true) : children.openai.hasSession(threadId),
          ),
        ),
    readThread: (threadId) =>
      resolveChild({ threadId, method: "readThread" }).pipe(
        Effect.flatMap((child) => child.readThread(threadId)),
      ),
    rollbackThread: (threadId, numTurns) =>
      resolveChild({ threadId, method: "rollbackThread" }).pipe(
        Effect.flatMap((child) => child.rollbackThread(threadId, numTurns)),
      ),
    stopAll: () =>
      children.anthropic.stopAll().pipe(
        Effect.andThen(children.openai.stopAll()),
        Effect.tap(() => Effect.sync(() => routes.clear())),
      ),
    get streamEvents() {
      return Stream.merge(
        children.anthropic.streamEvents.pipe(Stream.map(stampEvent)),
        children.openai.streamEvents.pipe(Stream.map(stampEvent)),
      );
    },
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
}

export const PostHogGatewayDriver: ProviderDriver<PostHogGatewaySettings, PostHogGatewayDriverEnv> =
  {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: DISPLAY_NAME,
      supportsMultipleInstances: true,
    },
    configSchema: PostHogGatewaySettings,
    defaultConfig: (): PostHogGatewaySettings => decodePostHogGatewaySettings({}),
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
        const baseUrl = resolveGatewayBaseUrl({
          configuredBaseUrl: config.baseUrl,
          environment,
        });
        const key = gatewayKey(environment);
        const keyValue = key?.value ?? "";

        const claudeChild = yield* ClaudeDriver.create({
          instanceId: childInstanceId(instanceId, "claude"),
          displayName,
          accentColor,
          enabled,
          environment: buildClaudeChildEnvironment({ environment, baseUrl, key: keyValue }),
          // No `homePath`: sharing the default Claude config dir is what lets
          // a plain Claude instance hand a started thread to this one.
          config: decodeClaudeSettings({ binaryPath: config.claudeBinaryPath }),
        });
        // The Codex child gets its own config directory. Sharing ~/.codex would
        // load the user's MCP servers and connector apps, which Codex advertises
        // as tool types the gateway bridge rejects; the gateway key authenticates
        // through env_key, so no login is needed there.
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const codexHomePath = path.join(NodeOS.homedir(), ".codex-ras", "posthog-gateway");
        yield* fileSystem.makeDirectory(codexHomePath, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId: String(instanceId),
                detail: `Could not create the gateway Codex home '${codexHomePath}'.`,
                cause,
              }),
          ),
        );
        const codexChild = yield* createCodexInstance(
          {
            instanceId: childInstanceId(instanceId, "codex"),
            displayName,
            accentColor,
            enabled,
            environment: buildCodexChildEnvironment({ environment, key: keyValue }),
            config: decodeCodexSettings({
              binaryPath: config.codexBinaryPath,
              homePath: codexHomePath,
              launchArgs: posthogGatewayCodexLaunchArgs(RAS_GATEWAY_KEY_VARIABLE, baseUrl)
                .launchArgs,
              // Codex advertises an attached MCP server as a `namespace` tool,
              // which the gateway's Responses bridge rejects outright.
              rasMcpServer: false,
            }),
          },
          { baseInstructions: postHogGatewayBaseInstructions },
        );

        const catalogRef = yield* Ref.make<ReadonlyArray<ProviderRemoteModel>>([]);
        const snapshotPubSub = yield* Effect.acquireRelease(
          PubSub.unbounded<ServerProvider>(),
          PubSub.shutdown,
        );

        const defaultModel = DEFAULT_MODEL_BY_PROVIDER[DRIVER_KIND] ?? "";
        const compose = Effect.fn("composePostHogGatewaySnapshot")(function* () {
          const [claude, codex, catalog] = yield* Effect.all(
            [
              claudeChild.snapshot.getSnapshot,
              codexChild.snapshot.getSnapshot,
              Ref.get(catalogRef),
            ],
            { concurrency: "unbounded" },
          );
          return composeGatewaySnapshot({
            instanceId,
            displayName,
            accentColor,
            enabled,
            continuationGroupKey: claudeChild.continuationIdentity.continuationKey,
            claude,
            codex,
            catalog,
            defaultModel,
            hasKey: keyValue.length > 0,
            baseUrl,
          });
        });

        const snapshotRef = yield* Ref.make(yield* compose());

        const publish = Effect.gen(function* () {
          const next = yield* compose();
          yield* Ref.set(snapshotRef, next);
          yield* PubSub.publish(snapshotPubSub, next);
          return next;
        });

        // Keep the last good catalog: a gateway blip must not empty the
        // model picker mid-session.
        const refreshCatalog =
          keyValue.length === 0
            ? Effect.void
            : fetchGatewayModels({
                instanceId,
                baseUrl,
                key: key ?? { name: RAS_GATEWAY_KEY_VARIABLE, value: keyValue },
              }).pipe(
                Effect.flatMap((models) => Ref.set(catalogRef, models)),
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.ignoreCause({ log: true }),
              );

        yield* refreshCatalog.pipe(
          Effect.andThen(publish),
          Effect.ignoreCause({ log: true }),
          Effect.forkScoped,
        );
        yield* refreshCatalog.pipe(
          Effect.andThen(publish),
          Effect.ignoreCause({ log: true }),
          Effect.repeat(Schedule.spaced(CATALOG_REFRESH_INTERVAL)),
          Effect.forkScoped,
        );

        // Republish whenever either harness re-probes, so the composite's
        // status, usage limit, and model capabilities track the children.
        yield* Stream.merge(
          claudeChild.snapshot.streamChanges,
          codexChild.snapshot.streamChanges,
        ).pipe(
          Stream.runForEach(() => publish.pipe(Effect.ignoreCause({ log: true }))),
          Effect.forkScoped,
        );

        const snapshot: ServerProviderShape = {
          maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
          }),
          getSnapshot: Ref.get(snapshotRef),
          refresh: Effect.all([claudeChild.snapshot.refresh, codexChild.snapshot.refresh], {
            concurrency: "unbounded",
          }).pipe(Effect.andThen(refreshCatalog), Effect.andThen(publish)),
          get streamChanges() {
            return Stream.fromPubSub(snapshotPubSub);
          },
        };

        const adapter = makeGatewayAdapter({
          instanceId,
          childInstanceIds: {
            anthropic: childInstanceId(instanceId, "claude"),
            openai: childInstanceId(instanceId, "codex"),
          },
          children: { anthropic: claudeChild.adapter, openai: codexChild.adapter },
        });

        // Text generation follows the same routing rule as turns: the model
        // the caller asked for decides the harness.
        const textGeneration: TextGeneration["Service"] = {
          generateCommitMessage: (input) =>
            textGenerationChild(input.modelSelection.model).generateCommitMessage(input),
          generatePrContent: (input) =>
            textGenerationChild(input.modelSelection.model).generatePrContent(input),
          generateBranchName: (input) =>
            textGenerationChild(input.modelSelection.model).generateBranchName(input),
          generateThreadTitle: (input) =>
            textGenerationChild(input.modelSelection.model).generateThreadTitle(input),
        };
        function textGenerationChild(model: string): TextGeneration["Service"] {
          return gatewayModelShape(model) === "anthropic"
            ? claudeChild.textGeneration
            : codexChild.textGeneration;
        }

        return {
          instanceId,
          driverKind: DRIVER_KIND,
          continuationIdentity: {
            driverKind: DRIVER_KIND,
            continuationKey: claudeChild.continuationIdentity.continuationKey,
          },
          displayName,
          accentColor,
          enabled,
          snapshot,
          adapter,
          textGeneration,
        } satisfies ProviderInstance;
      }),
  };
