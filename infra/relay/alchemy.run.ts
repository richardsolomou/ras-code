// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayDb from "./src/db.ts";
import { RelayTracingConfig } from "./src/observability.ts";
import { RelayApiZone, RelayGatewayZone } from "./src/zone.ts";
import ApiLive, { Api } from "./src/worker.ts";

export default Alchemy.Stack(
  "RasCodeRelay",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Drizzle.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDatabase;
    const hyperdrive = yield* RelayDb.RelayHyperdrive;
    const relayGatewayZone = yield* RelayGatewayZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const tracing = yield* RelayTracingConfig;
    const api = yield* Api;

    return {
      databaseName: db.origin.database,
      hyperdriveName: hyperdrive.name,
      workerName: api.workerName,
      url: api.url,
      relayApiZoneId: relayApiZone.zoneId,
      relayGatewayZoneId: relayGatewayZone.zoneId,
      mobileTracingUrl: tracing.tracesEndpoint,
      mobileTracingToken: Redacted.value(tracing.ingestToken),
      clientTracingUrl: tracing.tracesEndpoint,
      clientTracingToken: Redacted.value(tracing.ingestToken),
    };
  }).pipe(Effect.provide(ApiLive)),
);
