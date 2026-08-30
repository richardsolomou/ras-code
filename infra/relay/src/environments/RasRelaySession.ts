import * as Cloudflare from "alchemy/Cloudflare";
import {
  decodeRasRelayBatch,
  encodeRasRelayBatch,
  RAS_RELAY_MAX_FRAME_PAYLOAD_BYTES,
  RAS_RELAY_MAX_HTTP_REQUESTS,
  RAS_RELAY_MAX_HTTP_RESPONSE_BUFFER_BYTES,
  RAS_RELAY_MAX_STREAM_BYTES,
  RAS_RELAY_MAX_WEBSOCKETS,
  rasRelayClose,
  rasRelayPayloadFrames,
  type RasRelayFrame,
  type RasRelayMessage,
} from "@ras-code/shared/rasRelayProtocol";
import { stripManagedEndpointGatewayPrefix } from "@ras-code/shared/advertisedEndpoint";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

type SocketAttachment =
  | { readonly role: "connector" }
  | { readonly role: "client"; readonly id: string };

interface PendingHttpRequest {
  readonly started: Deferred.Deferred<HttpServerResponse.HttpServerResponse>;
  readonly bodyAllowed: boolean;
  response:
    | { readonly _tag: "awaiting" }
    | { readonly _tag: "bodyless" }
    | {
        readonly _tag: "streaming";
        readonly controller: ReadableStreamDefaultController<Uint8Array>;
      };
  responseBytes: number;
}

interface PendingWebSocket {
  readonly accepted: Deferred.Deferred<
    | { readonly accepted: true; readonly protocol?: string }
    | { readonly accepted: false; readonly status: number }
  >;
  closed: { readonly code: number; readonly reason: string } | null;
}

function pendingWebSocketClose(pending: PendingWebSocket): PendingWebSocket["closed"] {
  return pending.closed;
}

const emptyPayload = new Uint8Array();
const cloudflareCrypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.promise(async () => {
      const input = new Uint8Array(data.length);
      input.set(data);
      return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
    }),
});

function frame(message: RasRelayMessage, payload = emptyPayload): RasRelayFrame {
  return { message, payload };
}

function socketEquals(left: Cloudflare.WebSocket | null, right: Cloudflare.WebSocket): boolean {
  return left?.ws === right.ws;
}

function requestHeaders(request: Request): ReadonlyArray<readonly [string, string]> {
  return Array.from(request.headers.entries()).filter(
    ([name]) =>
      name !== "connection" &&
      name !== "host" &&
      name !== "keep-alive" &&
      name !== "proxy-connection" &&
      name !== "transfer-encoding" &&
      name !== "upgrade",
  );
}

function websocketProtocols(request: Request): ReadonlyArray<string> {
  return (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function hasResponseBody(status: number): boolean {
  return status !== 204 && status !== 205 && status !== 304;
}

export class RasRelaySessionDirectory extends Context.Service<
  RasRelaySessionDirectory,
  {
    readonly disconnect: (environmentId: string) => Effect.Effect<void>;
  }
>()("ras-code-relay/environments/RasRelaySession/RasRelaySessionDirectory") {}

export const makeRasRelaySession = Effect.all({
  crypto: Crypto.Crypto,
  state: Cloudflare.DurableObjectState,
}).pipe(
  Effect.map(({ crypto, state }) =>
    Effect.gen(function* () {
      const runFork = Effect.runForkWith(yield* Effect.context<never>());
      let connector: Cloudflare.WebSocket | null = null;
      const clients = new Map<string, Cloudflare.WebSocket>();
      const pendingHttp = new Map<string, PendingHttpRequest>();
      const pendingWebSockets = new Map<string, PendingWebSocket>();

      for (const socket of yield* state.getWebSockets()) {
        const attachment = socket.deserializeAttachment<SocketAttachment>();
        if (attachment?.role === "connector") {
          connector = socket;
        } else if (attachment?.role === "client") {
          clients.set(attachment.id, socket);
        }
      }

      const send = (socket: Cloudflare.WebSocket, frames: ReadonlyArray<RasRelayFrame>) =>
        socket.send(encodeRasRelayBatch(frames));

      const closeClients = Effect.fnUntraced(function* (code: number, reason: string) {
        for (const socket of clients.values()) {
          const close = rasRelayClose(code, reason);
          yield* socket.close(close.code, close.reason);
        }
        clients.clear();
      });

      const failPending = Effect.fnUntraced(function* () {
        for (const pending of pendingHttp.values()) {
          if (pending.response._tag === "streaming") {
            pending.response.controller.error(new Error("RAS relay connector disconnected"));
          } else if (pending.response._tag === "awaiting") {
            yield* Deferred.succeed(
              pending.started,
              HttpServerResponse.text("Environment is offline.", { status: 503 }),
            );
          }
        }
        pendingHttp.clear();
        for (const pending of pendingWebSockets.values()) {
          yield* Deferred.succeed(pending.accepted, { accepted: false, status: 503 });
        }
        pendingWebSockets.clear();
      });

      const rejectConnector = (socket: Cloudflare.WebSocket) =>
        socket.close(1008, "Invalid RAS relay message");

      const handleConnectorFrame = Effect.fnUntraced(function* (
        socket: Cloudflare.WebSocket,
        incoming: RasRelayFrame,
      ) {
        const { message, payload } = incoming;
        switch (message.type) {
          case "http_response_start": {
            const pending = pendingHttp.get(message.id);
            if (!pending) return;
            if (pending.response._tag !== "awaiting") return yield* rejectConnector(socket);
            if (!pending.bodyAllowed || !hasResponseBody(message.status)) {
              pending.response = { _tag: "bodyless" };
              yield* Deferred.succeed(
                pending.started,
                HttpServerResponse.fromWeb(
                  new Response(null, {
                    status: message.status,
                    headers: message.headers.map(([name, value]) => [name, value]),
                  }),
                ),
              );
              return;
            }
            let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
            const stream = new ReadableStream<Uint8Array>(
              {
                start: (value) => {
                  controller = value;
                },
                cancel: () => {
                  pendingHttp.delete(message.id);
                  if (socketEquals(connector, socket)) {
                    runFork(
                      send(socket, [frame({ type: "http_request_cancel", id: message.id })]).pipe(
                        Effect.ignore,
                      ),
                    );
                  }
                },
              },
              new ByteLengthQueuingStrategy({
                highWaterMark: RAS_RELAY_MAX_HTTP_RESPONSE_BUFFER_BYTES,
              }),
            );
            if (!controller) return yield* rejectConnector(socket);
            pending.response = { _tag: "streaming", controller };
            const response = new Response(stream, {
              status: message.status,
              headers: message.headers.map(([name, value]) => [name, value]),
            });
            yield* Deferred.succeed(pending.started, HttpServerResponse.fromWeb(response));
            return;
          }
          case "http_response_body": {
            const pending = pendingHttp.get(message.id);
            if (!pending || pending.response._tag !== "streaming") {
              return yield* rejectConnector(socket);
            }
            pending.responseBytes += payload.byteLength;
            if (pending.responseBytes > RAS_RELAY_MAX_STREAM_BYTES) {
              pending.response.controller.error(
                new Error("RAS relay response exceeded its size limit"),
              );
              pendingHttp.delete(message.id);
              yield* send(socket, [frame({ type: "http_request_cancel", id: message.id })]).pipe(
                Effect.ignore,
              );
              return;
            }
            if ((pending.response.controller.desiredSize ?? 0) < payload.byteLength) {
              pending.response.controller.error(new Error("RAS relay response consumer is slow"));
              pendingHttp.delete(message.id);
              yield* send(socket, [frame({ type: "http_request_cancel", id: message.id })]).pipe(
                Effect.ignore,
              );
              return;
            }
            pending.response.controller.enqueue(payload);
            return;
          }
          case "http_response_end": {
            const pending = pendingHttp.get(message.id);
            if (!pending || pending.response._tag === "awaiting") {
              return yield* rejectConnector(socket);
            }
            if (pending.response._tag === "streaming") pending.response.controller.close();
            pendingHttp.delete(message.id);
            return;
          }
          case "http_response_error": {
            const pending = pendingHttp.get(message.id);
            if (!pending) return;
            if (pending.response._tag === "streaming") {
              pending.response.controller.error(new Error(message.message));
            } else if (pending.response._tag === "awaiting") {
              yield* Deferred.succeed(
                pending.started,
                HttpServerResponse.text(message.message, { status: message.status }),
              );
            }
            pendingHttp.delete(message.id);
            return;
          }
          case "websocket_accept": {
            const pending = pendingWebSockets.get(message.id);
            if (!pending) return;
            yield* Deferred.succeed(pending.accepted, {
              accepted: true,
              ...(message.protocol ? { protocol: message.protocol } : {}),
            });
            return;
          }
          case "websocket_reject": {
            const pending = pendingWebSockets.get(message.id);
            if (!pending) return;
            yield* Deferred.succeed(pending.accepted, {
              accepted: false,
              status: message.status,
            });
            return;
          }
          case "websocket_message": {
            const client = clients.get(message.id);
            if (!client) return;
            yield* client.send(message.binary ? payload : new TextDecoder().decode(payload));
            return;
          }
          case "websocket_close": {
            const pending = pendingWebSockets.get(message.id);
            if (pending) {
              pending.closed = rasRelayClose(message.code, message.reason);
              yield* Deferred.succeed(pending.accepted, { accepted: false, status: 502 });
              return;
            }
            const client = clients.get(message.id);
            if (!client) return;
            clients.delete(message.id);
            const close = rasRelayClose(message.code, message.reason);
            yield* client.close(close.code, close.reason);
            return;
          }
          default:
            return yield* rejectConnector(socket);
        }
      });

      const connect = Effect.gen(function* () {
        if (connector) {
          yield* connector.close(1012, "Connector replaced");
          yield* closeClients(1012, "Connector replaced");
          yield* failPending();
        }
        const [response, socket] = yield* Cloudflare.upgrade();
        socket.serializeAttachment<SocketAttachment>({ role: "connector" });
        connector = socket;
        return response;
      });

      const proxyHttp = Effect.fnUntraced(function* (request: Request) {
        const targetConnector = connector;
        if (!targetConnector) {
          return HttpServerResponse.text("Environment is offline.", { status: 503 });
        }
        if (pendingHttp.size >= RAS_RELAY_MAX_HTTP_REQUESTS) {
          return HttpServerResponse.text("Environment is busy.", { status: 503 });
        }
        const contentLength = Number(request.headers.get("content-length") ?? "0");
        if (Number.isFinite(contentLength) && contentLength > RAS_RELAY_MAX_STREAM_BYTES) {
          return HttpServerResponse.text("Request body is too large.", { status: 413 });
        }
        const requestUrl = new URL(request.url);
        const path = `${requestUrl.pathname}${requestUrl.search}`;
        if (stripManagedEndpointGatewayPrefix(path) === null) {
          return HttpServerResponse.empty({ status: 404 });
        }
        const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const started = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
        pendingHttp.set(id, {
          started,
          bodyAllowed: request.method !== "HEAD",
          response: { _tag: "awaiting" },
          responseBytes: 0,
        });
        const startedSent = yield* send(targetConnector, [
          frame({
            type: "http_request_start",
            id,
            method: request.method,
            origin: requestUrl.origin,
            path,
            headers: requestHeaders(request),
          }),
        ]).pipe(Effect.result);
        if (startedSent._tag === "Failure") {
          pendingHttp.delete(id);
          return HttpServerResponse.text("Environment is offline.", { status: 503 });
        }
        const reader = request.body?.getReader();
        let requestBytes = 0;
        if (reader) {
          while (true) {
            const chunk = yield* Effect.promise(() => reader.read()).pipe(Effect.result);
            if (chunk._tag === "Failure") {
              pendingHttp.delete(id);
              yield* send(targetConnector, [frame({ type: "http_request_cancel", id })]).pipe(
                Effect.ignore,
              );
              return HttpServerResponse.text("Could not read request body.", { status: 400 });
            }
            if (chunk.success.done) break;
            requestBytes += chunk.success.value.byteLength;
            if (requestBytes > RAS_RELAY_MAX_STREAM_BYTES) {
              pendingHttp.delete(id);
              yield* Effect.promise(() => reader.cancel()).pipe(Effect.ignore);
              yield* send(targetConnector, [frame({ type: "http_request_cancel", id })]).pipe(
                Effect.ignore,
              );
              return HttpServerResponse.text("Request body is too large.", { status: 413 });
            }
            for (const bodyFrame of rasRelayPayloadFrames(
              { type: "http_request_body", id },
              chunk.success.value,
            )) {
              const sent = yield* send(targetConnector, [bodyFrame]).pipe(Effect.result);
              if (sent._tag === "Failure") {
                pendingHttp.delete(id);
                return HttpServerResponse.text("Environment is offline.", { status: 503 });
              }
            }
          }
        }
        const ended = yield* send(targetConnector, [frame({ type: "http_request_end", id })]).pipe(
          Effect.result,
        );
        if (ended._tag === "Failure") {
          pendingHttp.delete(id);
          return HttpServerResponse.text("Environment is offline.", { status: 503 });
        }
        return yield* Deferred.await(started).pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () =>
              Effect.gen(function* () {
                pendingHttp.delete(id);
                if (socketEquals(connector, targetConnector)) {
                  yield* send(targetConnector, [frame({ type: "http_request_cancel", id })]).pipe(
                    Effect.ignore,
                  );
                }
                return HttpServerResponse.text("Environment request timed out.", { status: 504 });
              }),
          }),
        );
      });

      const proxyWebSocket = Effect.fnUntraced(function* (request: Request) {
        const targetConnector = connector;
        if (!targetConnector) {
          return HttpServerResponse.text("Environment is offline.", { status: 503 });
        }
        if (clients.size + pendingWebSockets.size >= RAS_RELAY_MAX_WEBSOCKETS) {
          return HttpServerResponse.text("Environment is busy.", { status: 503 });
        }
        const requestUrl = new URL(request.url);
        const path = `${requestUrl.pathname}${requestUrl.search}`;
        if (stripManagedEndpointGatewayPrefix(path) === null) {
          return HttpServerResponse.empty({ status: 404 });
        }
        const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const accepted = yield* Deferred.make<
          | { readonly accepted: true; readonly protocol?: string }
          | { readonly accepted: false; readonly status: number }
        >();
        const pending = { accepted, closed: null } satisfies PendingWebSocket;
        pendingWebSockets.set(id, pending);
        const sent = yield* send(targetConnector, [
          frame({
            type: "websocket_open",
            id,
            origin: requestUrl.origin,
            path,
            headers: requestHeaders(request),
            protocols: websocketProtocols(request),
          }),
        ]).pipe(Effect.result);
        if (sent._tag === "Failure") {
          pendingWebSockets.delete(id);
          return HttpServerResponse.text("Environment is offline.", { status: 503 });
        }
        const result = yield* Deferred.await(accepted).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () =>
              (socketEquals(connector, targetConnector)
                ? send(targetConnector, [
                    frame({
                      type: "websocket_close",
                      id,
                      code: 1001,
                      reason: "Relay request timed out",
                    }),
                  ]).pipe(Effect.ignore)
                : Effect.void
              ).pipe(Effect.as({ accepted: false as const, status: 504 })),
          }),
        );
        if (pending.closed) {
          pendingWebSockets.delete(id);
          return HttpServerResponse.empty({ status: 502 });
        }
        if (!result.accepted) {
          pendingWebSockets.delete(id);
          return HttpServerResponse.empty({ status: result.status });
        }
        if (!socketEquals(connector, targetConnector)) {
          pendingWebSockets.delete(id);
          return HttpServerResponse.text("Environment is offline.", { status: 503 });
        }
        const [response, socket] = yield* Cloudflare.upgrade();
        socket.serializeAttachment<SocketAttachment>({ role: "client", id });
        const closedDuringUpgrade = pendingWebSocketClose(pending);
        if (closedDuringUpgrade) {
          pendingWebSockets.delete(id);
          yield* socket.close(closedDuringUpgrade.code, closedDuringUpgrade.reason);
          return response;
        }
        clients.set(id, socket);
        pendingWebSockets.delete(id);
        const readySent = yield* send(targetConnector, [
          frame({ type: "websocket_ready", id }),
        ]).pipe(Effect.result);
        if (readySent._tag === "Failure") {
          clients.delete(id);
          yield* socket.close(1012, "Environment is offline");
        }
        return result.protocol
          ? HttpServerResponse.setHeader(response, "sec-websocket-protocol", result.protocol)
          : response;
      });

      return {
        disconnect: Effect.fn(function* () {
          if (connector) {
            yield* connector.close(1008, "Environment unlinked");
            connector = null;
          }
          yield* closeClients(1008, "Environment unlinked");
          yield* failPending();
        }),
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const source = yield* HttpServerRequest.toWeb(request);
          if (source.headers.get("x-ras-relay-connector") === "1") {
            return yield* connect;
          }
          return source.headers.get("upgrade")?.toLowerCase() === "websocket"
            ? yield* proxyWebSocket(source)
            : yield* proxyHttp(source);
        }),
        webSocketMessage: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          message: string | ArrayBuffer,
        ) {
          const attachment = socket.deserializeAttachment<SocketAttachment>();
          if (attachment?.role === "connector") {
            if (!socketEquals(connector, socket) || typeof message === "string") {
              return yield* rejectConnector(socket);
            }
            const frames = decodeRasRelayBatch(message);
            if (!frames) return yield* rejectConnector(socket);
            for (const incoming of frames) {
              yield* handleConnectorFrame(socket, incoming);
            }
            return;
          }
          if (attachment?.role !== "client") {
            return yield* rejectConnector(socket);
          }
          if (!connector) {
            return yield* socket.close(1012, "Environment is offline");
          }
          const payload =
            typeof message === "string"
              ? new TextEncoder().encode(message)
              : new Uint8Array(message);
          if (payload.byteLength > RAS_RELAY_MAX_FRAME_PAYLOAD_BYTES) {
            return yield* socket.close(1009, "Message is too large");
          }
          yield* send(connector, [
            frame(
              {
                type: "websocket_message",
                id: attachment.id,
                binary: typeof message !== "string",
              },
              payload,
            ),
          ]);
        }),
        webSocketClose: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          code: number,
          reason: string,
          _wasClean: boolean,
        ) {
          const attachment = socket.deserializeAttachment<SocketAttachment>();
          if (attachment?.role === "connector" && socketEquals(connector, socket)) {
            connector = null;
            yield* closeClients(1012, "Environment is offline");
            yield* failPending();
          } else if (
            attachment?.role === "client" &&
            clients.get(attachment.id)?.ws === socket.ws
          ) {
            clients.delete(attachment.id);
            if (connector) {
              yield* send(connector, [
                frame({
                  type: "websocket_close",
                  id: attachment.id,
                  ...rasRelayClose(code, reason),
                }),
              ]);
            }
          }
          yield* socket.close(code, reason);
        }),
      };
    }),
  ),
  Effect.provideService(Crypto.Crypto, cloudflareCrypto),
);

export class RasRelaySession extends Cloudflare.DurableObject<RasRelaySession>()(
  "RasRelaySessions",
  makeRasRelaySession,
) {}
