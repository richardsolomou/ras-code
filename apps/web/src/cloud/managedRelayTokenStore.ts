import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { readCloudAuthEntry, writeCloudAuthEntry } from "./dpop";

const MANAGED_RELAY_TOKEN_CACHE_KEY = "relay-access-tokens";
const MANAGED_RELAY_TOKEN_CACHE_VERSION = 1;

const ManagedRelayAccessTokenCacheEntrySchema = Schema.Struct({
  accountId: Schema.String,
  clientId: Schema.Literals(["ras-mobile", "ras-web"]),
  relayUrl: Schema.String,
  thumbprint: Schema.String,
  scopes: Schema.Array(
    Schema.Literals(["environment:connect", "environment:status", "mobile:registration"]),
  ),
  accessToken: Schema.String,
  expiresAtMillis: Schema.Number,
});

const ManagedRelayAccessTokenCacheSchema = Schema.Struct({
  version: Schema.Literal(MANAGED_RELAY_TOKEN_CACHE_VERSION),
  entries: Schema.Array(ManagedRelayAccessTokenCacheEntrySchema),
});

const decodeManagedRelayAccessTokenCache = Schema.decodeUnknownEffect(
  ManagedRelayAccessTokenCacheSchema,
);

function logStoreFailure(cause: unknown) {
  return Effect.logWarning("Managed relay token store operation failed.", { cause });
}

const loadManagedRelayAccessTokens = readCloudAuthEntry(MANAGED_RELAY_TOKEN_CACHE_KEY).pipe(
  Effect.flatMap((entry) =>
    entry === null
      ? Effect.succeed<ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry>>([])
      : decodeManagedRelayAccessTokenCache(entry).pipe(Effect.map((cache) => cache.entries)),
  ),
);

const saveManagedRelayAccessTokens = (
  entries: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry>,
) =>
  writeCloudAuthEntry(MANAGED_RELAY_TOKEN_CACHE_KEY, {
    version: MANAGED_RELAY_TOKEN_CACHE_VERSION,
    entries: entries.map((entry) => ({ ...entry, scopes: [...entry.scopes] })),
  });

export const managedRelayAccessTokenStore: ManagedRelay.ManagedRelayAccessTokenStore = {
  load: loadManagedRelayAccessTokens.pipe(
    Effect.tapError(logStoreFailure),
    Effect.orElseSucceed(() => []),
    Effect.withSpan("web.managedRelayTokenStore.load"),
  ),
  save: Effect.fn("web.managedRelayTokenStore.save")((entries) =>
    saveManagedRelayAccessTokens(entries).pipe(Effect.tapError(logStoreFailure), Effect.ignore),
  ),
  clear: writeCloudAuthEntry(MANAGED_RELAY_TOKEN_CACHE_KEY, {
    version: MANAGED_RELAY_TOKEN_CACHE_VERSION,
    entries: [],
  }).pipe(
    Effect.tapError(logStoreFailure),
    Effect.ignore,
    Effect.withSpan("web.managedRelayTokenStore.clear"),
  ),
};
