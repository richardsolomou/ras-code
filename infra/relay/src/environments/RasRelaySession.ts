import * as Cloudflare from "alchemy/Cloudflare";
import {
  decodeRasRelayBatch,
  encodeRasRelayBatch,
  RAS_RELAY_MAX_FRAME_PAYLOAD_BYTES,
  RAS_RELAY_MAX_HTTP_REQUESTS,
  RAS_RELAY_MAX_STREAM_BYTES,
  RAS_RELAY_MAX_WEBSOCKETS,
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
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  responseBytes: number;
}

interface PendingWebSocket {
  readonly accepted: Deferred.Deferred<
    | { readonly accepted: true; readonly protocol?: string }
    | { readonly accepted: false; readonly status: number }
  >;
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

function splitPayload(
  message: Extract<RasRelayMessage, { readonly type: "http_request_body" }>,
  payload: Uint8Array,
): ReadonlyArray<RasRelayFrame> {
  const frames: Array<RasRelayFrame> = [];
  for (let offset = 0; offset < payload.byteLength; offset += RAS_RELAY_MAX_FRAME_PAYLOAD_BYTES) {
    frames.push(frame(message, payload.slice(offset, offset + RAS_RELAY_MAX_FRAME_PAYLOAD_BYTES)));
  }
  return frames;
}

export class RasRelaySessionDirectory extends Context.Service<
  RasRelaySessionDirectory,
  {
    readonly disconnect: (environmentId: string) => Effect.Effect<void>;
  }
>()("ras-code-relay/environments/RasRelaySession/RasRelaySessionDirectory") {}

export class RasRelaySession extends Cloudflare.DurableObject<RasRelaySession>()(
  "RasRelaySessions",
  Effect.all({
    crypto: Crypto.Crypto,
    state: Cloudflare.DurableObjectState,
  }).pipe(
    Effect.map(({ crypto, state }) =>
      Effect.gen(function* () {
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
            yield* socket.close(code, reason);
          }
          clients.clear();
        });

        const failPending = Effect.fnUntraced(function* () {
          for (const pending of pendingHttp.values()) {
            if (pending.controller) {
              pending.controller.error(new Error("RAS relay connector disconnected"));
            } else {
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
              if (pending.controller) return yield* rejectConnector(socket);
              let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
              const stream = new ReadableStream<Uint8Array>({
                start: (value) => {
                  controller = value;
                },
              });
              pending.controller = controller;
              const response = new Response(stream, {
                status: message.status,
                headers: message.headers.map(([name, value]) => [name, value]),
              });
              yield* Deferred.succeed(pending.started, HttpServerResponse.fromWeb(response));
              return;
            }
            case "http_response_body": {
              const pending = pendingHttp.get(message.id);
              if (!pending?.controller) return yield* rejectConnector(socket);
              pending.responseBytes += payload.byteLength;
              if (pending.responseBytes > RAS_RELAY_MAX_STREAM_BYTES) {
                pending.controller.error(new Error("RAS relay response exceeded its size limit"));
                pendingHttp.delete(message.id);
                return;
              }
              pending.controller.enqueue(payload);
              return;
            }
            case "http_response_end": {
              const pending = pendingHttp.get(message.id);
              if (!pending?.controller) return yield* rejectConnector(socket);
              pending.controller.close();
              pendingHttp.delete(message.id);
              return;
            }
            case "http_response_error": {
              const pending = pendingHttp.get(message.id);
              if (!pending) return;
              if (pending.controller) {
                pending.controller.error(new Error(message.message));
              } else {
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
              const client = clients.get(message.id);
              if (!client) return;
              clients.delete(message.id);
              yield* client.close(message.code, message.reason);
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
          pendingHttp.set(id, { started, controller: null, responseBytes: 0 });
          const bodyResult = yield* Effect.promise(() => request.arrayBuffer()).pipe(Effect.result);
          if (bodyResult._tag === "Failure") {
            pendingHttp.delete(id);
            return HttpServerResponse.text("Could not read request body.", { status: 400 });
          }
          const body = new Uint8Array(bodyResult.success);
          if (body.byteLength > RAS_RELAY_MAX_STREAM_BYTES) {
            pendingHttp.delete(id);
            return HttpServerResponse.text("Request body is too large.", { status: 413 });
          }
          const frames = [
            frame({
              type: "http_request_start",
              id,
              method: request.method,
              origin: requestUrl.origin,
              path,
              headers: requestHeaders(request),
            }),
            ...splitPayload({ type: "http_request_body", id }, body),
            frame({ type: "http_request_end", id }),
          ];
          const sent = yield* Effect.gen(function* () {
            for (let offset = 0; offset < frames.length; offset += 3) {
              yield* send(targetConnector, frames.slice(offset, offset + 3));
            }
          }).pipe(Effect.result);
          if (sent._tag === "Failure") {
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
          pendingWebSockets.set(id, { accepted });
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
          pendingWebSockets.delete(id);
          if (!result.accepted) {
            return HttpServerResponse.empty({ status: result.status });
          }
          if (!socketEquals(connector, targetConnector)) {
            return HttpServerResponse.text("Environment is offline.", { status: 503 });
          }
          const [response, socket] = yield* Cloudflare.upgrade();
          socket.serializeAttachment<SocketAttachment>({ role: "client", id });
          clients.set(id, socket);
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
                    code: code >= 1_000 && code <= 4_999 ? code : 1001,
                    reason: reason.slice(0, 123),
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
  ),
) {}
