import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import type { RelayManagedEndpointRuntimeConfig } from "@ras-code/contracts/relay";
import {
  decodeRasRelayBatch,
  encodeRasRelayBatch,
  RAS_RELAY_MAX_BATCH_BYTES,
  RAS_RELAY_MAX_BATCH_FRAMES,
  RAS_RELAY_MAX_FRAME_PAYLOAD_BYTES,
  RAS_RELAY_MAX_HTTP_REQUESTS,
  RAS_RELAY_MAX_SOCKET_BUFFER_BYTES,
  RAS_RELAY_PUBLIC_ORIGIN_HEADER,
  RAS_RELAY_MAX_STREAM_BYTES,
  RAS_RELAY_MAX_WEBSOCKETS,
  parseRasRelayPublicOrigin,
  rasRelayClose,
  rasRelayFrameByteLength,
  rasRelayPayloadFrames,
  type RasRelayFrame,
  type RasRelayMessage,
} from "@ras-code/shared/rasRelayProtocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMethod } from "effect/unstable/http";

interface PendingHttpRequest {
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly chunks: Array<Uint8Array>;
  byteLength: number;
  accounted: boolean;
}

interface LocalWebSocket {
  readonly socket: NodeSocket.NodeWS.WebSocket;
  readonly buffered: Array<{ readonly data: NodeSocket.NodeWS.RawData; readonly binary: boolean }>;
  bufferedBytes: number;
  ready: boolean;
}

export class RasRelayConnectorStartError extends Schema.TaggedErrorClass<RasRelayConnectorStartError>()(
  "RasRelayConnectorStartError",
  {
    stage: Schema.Literals(["validate-config", "open-connector"]),
    cause: Schema.Defect(),
  },
) {}

export interface RasRelayConnectorHandle {
  readonly socket: NodeSocket.NodeWS.WebSocket;
  readonly closed: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  readonly isRunning: Effect.Effect<boolean>;
}

const emptyPayload = new Uint8Array();
const textDecoder = new TextDecoder();
const MAX_BUFFERED_HTTP_REQUEST_BYTES = RAS_RELAY_MAX_STREAM_BYTES * 2;

function frame(message: RasRelayMessage, payload = emptyPayload): RasRelayFrame {
  return { message, payload };
}

function localOrigin(config: RelayManagedEndpointRuntimeConfig): URL | null {
  const host = config.localHttpHost.includes(":")
    ? `[${config.localHttpHost.replace(/^\[|\]$/gu, "")}]`
    : config.localHttpHost;
  return new URL(`http://${host}:${config.localHttpPort}/`);
}

function localUrl(origin: URL, path: string, protocol: "http:" | "ws:"): URL | null {
  try {
    const url = new URL(path, origin);
    if (url.origin !== origin.origin) return null;
    url.protocol = protocol;
    return url;
  } catch {
    return null;
  }
}

function forwardedHeaders(
  values: ReadonlyArray<readonly [string, string]>,
  websocket: boolean,
): Record<string, string> {
  const blocked = new Set([
    "connection",
    "content-encoding",
    "content-length",
    "host",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "upgrade",
    RAS_RELAY_PUBLIC_ORIGIN_HEADER,
    ...(websocket
      ? [
          "sec-websocket-accept",
          "sec-websocket-extensions",
          "sec-websocket-key",
          "sec-websocket-protocol",
          "sec-websocket-version",
        ]
      : []),
  ]);
  return Object.fromEntries(values.filter(([name]) => !blocked.has(name.toLowerCase())));
}

function concatChunks(chunks: ReadonlyArray<Uint8Array>, byteLength: number): Uint8Array {
  return Buffer.concat(chunks, byteLength);
}

function rawDataBytes(data: NodeSocket.NodeWS.RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function rasRelaySocketBufferHasCapacity(
  bufferedAmount: number,
  nextBatchBytes: number,
): boolean {
  return bufferedAmount + nextBatchBytes <= RAS_RELAY_MAX_SOCKET_BUFFER_BYTES;
}

export const start = Effect.fn("RasRelayConnector.start")(function* (
  config: RelayManagedEndpointRuntimeConfig,
) {
  const origin = localOrigin(config);
  if (config.providerKind !== "ras_relay" || !origin) {
    return yield* new RasRelayConnectorStartError({
      stage: "validate-config",
      cause: "RAS relay runtime config is incomplete",
    });
  }

  const opened = yield* Deferred.make<void, RasRelayConnectorStartError>();
  const closed = yield* Deferred.make<void>();
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const requests = new Map<string, PendingHttpRequest>();
  const inFlightHttpRequests = new Map<string, AbortController>();
  const localSockets = new Map<string, LocalWebSocket>();
  const connector = new NodeSocket.NodeWS.WebSocket(config.connectorUrl, {
    headers: { authorization: `Bearer ${config.connectorToken}` },
    perMessageDeflate: false,
  });
  connector.binaryType = "arraybuffer";

  let outgoing: Array<RasRelayFrame> = [];
  let outgoingBytes = 6;
  let flushScheduled = false;
  let bufferedHttpRequestBytes = 0;

  const releaseRequestBytes = (request: PendingHttpRequest) => {
    if (!request.accounted) return;
    request.accounted = false;
    bufferedHttpRequestBytes -= request.byteLength;
  };

  const flush = () => {
    flushScheduled = false;
    if (outgoing.length === 0 || connector.readyState !== NodeSocket.NodeWS.WebSocket.OPEN) {
      outgoing = [];
      outgoingBytes = 6;
      return;
    }
    const batch = outgoing;
    outgoing = [];
    outgoingBytes = 6;
    const encoded = encodeRasRelayBatch(batch);
    if (!rasRelaySocketBufferHasCapacity(connector.bufferedAmount, encoded.byteLength)) {
      connector.close(1_013, "Relay connection is too slow");
      return;
    }
    connector.send(encoded);
  };

  const send = (next: RasRelayFrame) =>
    Effect.sync(() => {
      const estimated = rasRelayFrameByteLength(next);
      if (
        outgoing.length > 0 &&
        (outgoing.length >= RAS_RELAY_MAX_BATCH_FRAMES ||
          outgoingBytes + estimated > RAS_RELAY_MAX_BATCH_BYTES)
      ) {
        flush();
      }
      outgoing.push(next);
      outgoingBytes += estimated;
      if (outgoing.length >= RAS_RELAY_MAX_BATCH_FRAMES) {
        flush();
      } else if (!flushScheduled) {
        flushScheduled = true;
        runFork(Effect.sleep("5 millis").pipe(Effect.andThen(Effect.sync(flush))));
      }
    });

  const sendHttpResponse = (
    id: string,
    request: PendingHttpRequest,
    abortController: AbortController,
  ) => {
    return Effect.gen(function* () {
      const url = localUrl(origin, request.path, "http:");
      if (!url || !parseRasRelayPublicOrigin(request.origin)) {
        yield* send(
          frame({ type: "http_response_error", id, status: 400, message: "Invalid relay path." }),
        );
        return;
      }
      if (!HttpMethod.isHttpMethod(request.method)) {
        yield* send(
          frame({ type: "http_response_error", id, status: 400, message: "Invalid HTTP method." }),
        );
        return;
      }
      const body = concatChunks(request.chunks, request.byteLength);
      request.chunks.length = 0;
      const headers: Record<string, string> = {
        ...forwardedHeaders(request.headers, false),
        "accept-encoding": "identity",
        [RAS_RELAY_PUBLIC_ORIGIN_HEADER]: request.origin,
      };
      let localRequest = HttpClientRequest.make(request.method)(url, { headers });
      if (HttpMethod.hasBody(request.method)) {
        localRequest = HttpClientRequest.bodyUint8Array(
          localRequest,
          body,
          headers["content-type"],
        );
      }
      const response = yield* HttpClient.execute(localRequest);
      const responseHeaders = Object.entries(
        forwardedHeaders(
          Object.entries(response.headers).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
          false,
        ),
      );
      yield* send(
        frame({
          type: "http_response_start",
          id,
          status: response.status,
          headers: responseHeaders,
        }),
      );
      let responseBytes = 0;
      let responseTooLarge = false;
      yield* response.stream.pipe(
        Stream.runForEachWhile((part) => {
          responseBytes += part.byteLength;
          if (responseBytes > RAS_RELAY_MAX_STREAM_BYTES) {
            responseTooLarge = true;
            return Effect.succeed(false);
          }
          return Effect.forEach(
            rasRelayPayloadFrames({ type: "http_response_body", id }, part),
            send,
            { discard: true },
          ).pipe(Effect.as(true));
        }),
      );
      if (responseTooLarge) {
        yield* send(
          frame({
            type: "http_response_error",
            id,
            status: 502,
            message: "Local environment response exceeded its size limit.",
          }),
        );
        return;
      }
      yield* send(frame({ type: "http_response_end", id }));
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        signal: abortController.signal,
      }),
      Effect.provide(FetchHttpClient.layer),
      Effect.scoped,
      Effect.timeout("30 seconds"),
      Effect.catch(() =>
        send(
          frame({
            type: "http_response_error",
            id,
            status: 502,
            message: "Local environment request failed.",
          }),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          inFlightHttpRequests.delete(id);
          releaseRequestBytes(request);
        }),
      ),
    );
  };

  const openLocalWebSocket = Effect.fnUntraced(function* (
    message: Extract<RasRelayMessage, { readonly type: "websocket_open" }>,
  ) {
    if (localSockets.size >= RAS_RELAY_MAX_WEBSOCKETS) {
      yield* send(frame({ type: "websocket_reject", id: message.id, status: 503 }));
      return;
    }
    const url = localUrl(origin, message.path, "ws:");
    if (!url || !parseRasRelayPublicOrigin(message.origin)) {
      yield* send(frame({ type: "websocket_reject", id: message.id, status: 400 }));
      return;
    }
    const socket = new NodeSocket.NodeWS.WebSocket(url, [...message.protocols], {
      headers: {
        ...forwardedHeaders(message.headers, true),
        [RAS_RELAY_PUBLIC_ORIGIN_HEADER]: message.origin,
      },
      perMessageDeflate: false,
    });
    socket.binaryType = "arraybuffer";
    const local: LocalWebSocket = {
      socket,
      buffered: [],
      bufferedBytes: 0,
      ready: false,
    };
    localSockets.set(message.id, local);
    socket.once("open", () => {
      runFork(
        send(
          frame({
            type: "websocket_accept",
            id: message.id,
            ...(socket.protocol ? { protocol: socket.protocol } : {}),
          }),
        ),
      );
    });
    socket.on("message", (data, binary) => {
      const bytes = rawDataBytes(data);
      if (bytes.byteLength > RAS_RELAY_MAX_FRAME_PAYLOAD_BYTES) {
        socket.close(1009, "Message is too large");
        return;
      }
      if (!local.ready) {
        local.bufferedBytes += bytes.byteLength;
        if (local.bufferedBytes > RAS_RELAY_MAX_STREAM_BYTES) {
          socket.close(1009, "Buffered messages are too large");
          return;
        }
        local.buffered.push({ data, binary });
        return;
      }
      runFork(send(frame({ type: "websocket_message", id: message.id, binary }, bytes.slice())));
    });
    socket.once("error", () => {
      if (socket.readyState !== NodeSocket.NodeWS.WebSocket.OPEN) {
        runFork(send(frame({ type: "websocket_reject", id: message.id, status: 502 })));
      }
    });
    socket.once("close", (code, reason) => {
      if (localSockets.get(message.id) !== local) return;
      localSockets.delete(message.id);
      runFork(
        send(
          frame({
            type: "websocket_close",
            id: message.id,
            ...rasRelayClose(code, reason.toString()),
          }),
        ),
      );
    });
  });

  const handle = Effect.fnUntraced(function* (incoming: RasRelayFrame) {
    const { message, payload } = incoming;
    switch (message.type) {
      case "http_request_start":
        if (requests.has(message.id)) return;
        if (requests.size + inFlightHttpRequests.size >= RAS_RELAY_MAX_HTTP_REQUESTS) {
          yield* send(
            frame({
              type: "http_response_error",
              id: message.id,
              status: 503,
              message: "Relay request concurrency limit reached.",
            }),
          );
          return;
        }
        requests.set(message.id, {
          method: message.method,
          origin: message.origin,
          path: message.path,
          headers: message.headers,
          chunks: [],
          byteLength: 0,
          accounted: true,
        });
        return;
      case "http_request_body": {
        const request = requests.get(message.id);
        if (!request) return;
        request.byteLength += payload.byteLength;
        bufferedHttpRequestBytes += payload.byteLength;
        const requestTooLarge = request.byteLength > RAS_RELAY_MAX_STREAM_BYTES;
        const connectorBusy = bufferedHttpRequestBytes > MAX_BUFFERED_HTTP_REQUEST_BYTES;
        if (requestTooLarge || connectorBusy) {
          requests.delete(message.id);
          releaseRequestBytes(request);
          yield* send(
            frame({
              type: "http_response_error",
              id: message.id,
              status: requestTooLarge ? 413 : 503,
              message: requestTooLarge
                ? "Relay request exceeded its size limit."
                : "Relay request buffer is full.",
            }),
          );
          return;
        }
        request.chunks.push(payload.slice());
        return;
      }
      case "http_request_end": {
        const request = requests.get(message.id);
        if (!request) return;
        requests.delete(message.id);
        const abortController = new AbortController();
        inFlightHttpRequests.set(message.id, abortController);
        yield* Effect.forkDetach(sendHttpResponse(message.id, request, abortController));
        return;
      }
      case "http_request_cancel": {
        const request = requests.get(message.id);
        if (request) {
          requests.delete(message.id);
          releaseRequestBytes(request);
        }
        inFlightHttpRequests.get(message.id)?.abort();
        return;
      }
      case "websocket_open":
        yield* openLocalWebSocket(message);
        return;
      case "websocket_ready": {
        const local = localSockets.get(message.id);
        if (!local) return;
        local.ready = true;
        for (const buffered of local.buffered) {
          const bytes = rawDataBytes(buffered.data);
          yield* send(
            frame(
              { type: "websocket_message", id: message.id, binary: buffered.binary },
              bytes.slice(),
            ),
          );
        }
        local.buffered.length = 0;
        local.bufferedBytes = 0;
        return;
      }
      case "websocket_message": {
        const local = localSockets.get(message.id);
        if (!local || local.socket.readyState !== NodeSocket.NodeWS.WebSocket.OPEN) return;
        if (!rasRelaySocketBufferHasCapacity(local.socket.bufferedAmount, payload.byteLength)) {
          local.socket.close(1_013, "Relay client is too slow");
          return;
        }
        local.socket.send(message.binary ? payload : textDecoder.decode(payload), {
          binary: message.binary,
        });
        return;
      }
      case "websocket_close": {
        const local = localSockets.get(message.id);
        if (!local) return;
        localSockets.delete(message.id);
        const close = rasRelayClose(message.code, message.reason);
        local.socket.close(close.code, close.reason);
        return;
      }
      default:
        connector.close(1008, "Invalid RAS relay message");
    }
  });

  connector.once("open", () => runFork(Deferred.succeed(opened, undefined)));
  connector.once("error", (cause) =>
    runFork(
      Deferred.fail(opened, new RasRelayConnectorStartError({ stage: "open-connector", cause })),
    ),
  );
  connector.on("message", (data, binary) => {
    if (!binary) {
      connector.close(1008, "Invalid RAS relay message");
      return;
    }
    const frames = decodeRasRelayBatch(rawDataBytes(data));
    if (!frames) {
      connector.close(1008, "Invalid RAS relay message");
      return;
    }
    runFork(
      Effect.forEach(frames, handle, { discard: true }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("RAS relay connector message failed", { cause }),
        ),
      ),
    );
  });
  connector.once("close", () => {
    for (const request of requests.values()) releaseRequestBytes(request);
    requests.clear();
    for (const request of inFlightHttpRequests.values()) request.abort();
    inFlightHttpRequests.clear();
    for (const local of localSockets.values()) local.socket.close(1012, "Relay disconnected");
    localSockets.clear();
    runFork(Deferred.succeed(closed, undefined));
  });

  yield* Deferred.await(opened).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        new RasRelayConnectorStartError({
          stage: "open-connector",
          cause: "RAS relay connector timed out",
        }),
    }),
    Effect.tapError(() => Effect.sync(() => connector.close())),
  );

  const close = Effect.sync(() => {
    flushScheduled = false;
    connector.close(1000, "Connector stopped");
    for (const local of localSockets.values()) local.socket.close(1012, "Relay disconnected");
  });

  return {
    socket: connector,
    closed: Deferred.await(closed),
    close,
    isRunning: Effect.sync(() => connector.readyState === NodeSocket.NodeWS.WebSocket.OPEN),
  } satisfies RasRelayConnectorHandle;
});
