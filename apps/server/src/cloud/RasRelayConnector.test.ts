// @effect-diagnostics nodeBuiltinImport:off - Connector integration exercises the Node HTTP boundary.
import * as NodeHttp from "node:http";
import * as NodeZlib from "node:zlib";

import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";
import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@ras-code/contracts";
import {
  decodeRasRelayBatch,
  encodeRasRelayBatch,
  RAS_RELAY_MAX_SOCKET_BUFFER_BYTES,
  RAS_RELAY_MAX_STREAM_BYTES,
  type RasRelayFrame,
} from "@ras-code/shared/rasRelayProtocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as RasRelayConnector from "./RasRelayConnector.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function listenHttp(server: NodeHttp.Server) {
  return Effect.callback<NodeHttp.Server, Error>((resume) => {
    const onError = (cause: Error) => resume(Effect.fail(cause));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resume(Effect.succeed(server));
    });
  });
}

function listenWebSocketServer(options?: { readonly autoPong?: boolean }) {
  return Effect.callback<NodeSocket.NodeWS.WebSocketServer, Error>((resume) => {
    const server = new NodeSocket.NodeWS.WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      ...(options?.autoPong === undefined ? {} : { autoPong: options.autoPong }),
    });
    server.once("listening", () => resume(Effect.succeed(server)));
    server.once("error", (cause) => resume(Effect.fail(cause)));
  });
}

function portOf(server: NodeHttp.Server | NodeSocket.NodeWS.WebSocketServer): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no TCP port");
  return address.port;
}

function closeHttp(server: NodeHttp.Server) {
  return Effect.callback<void>((resume) => {
    server.closeAllConnections();
    server.close(() => resume(Effect.void));
  });
}

function closeWebSocketServer(server: NodeSocket.NodeWS.WebSocketServer) {
  return Effect.callback<void>((resume) => {
    for (const socket of server.clients) socket.terminate();
    server.close(() => resume(Effect.void));
  });
}

function bytes(data: NodeSocket.NodeWS.RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const output = new Uint8Array(data.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of data) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

interface PromiseLatch<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
}

function promiseLatch<A>(): PromiseLatch<A> {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function awaitTest<A>(latch: PromiseLatch<A>, label: string) {
  return Effect.promise(() => latch.promise).pipe(
    Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${label}`)),
    }),
  );
}

describe("RasRelayConnector", () => {
  it.live("forwards relay HTTP and WebSocket traffic to the local server", () =>
    Effect.gen(function* () {
      const observedRequest = promiseLatch<{
        readonly path: string;
        readonly body: string;
        readonly acceptEncoding: string | undefined;
        readonly publicOrigin: string | undefined;
      }>();
      const localServer = yield* listenHttp(
        NodeHttp.createServer((request, response) => {
          const chunks: Array<Uint8Array> = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.once("end", () => {
            observedRequest.resolve({
              path: request.url ?? "",
              body: textDecoder.decode(Buffer.concat(chunks)),
              acceptEncoding: request.headers["accept-encoding"],
              publicOrigin: request.headers["x-ras-relay-public-origin"] as string | undefined,
            });
            response.writeHead(201, { "content-type": "text/plain", "x-relayed": "yes" });
            response.end("local response");
          });
        }),
      );
      yield* Effect.addFinalizer(() => closeHttp(localServer));
      const localWebSocketServer = new NodeSocket.NodeWS.WebSocketServer({ server: localServer });
      yield* Effect.addFinalizer(() => closeWebSocketServer(localWebSocketServer));
      const localWebSocket = promiseLatch<{
        readonly socket: NodeSocket.NodeWS.WebSocket;
        readonly path: string;
        readonly protocol: string;
        readonly publicOrigin: string | undefined;
      }>();
      const localWebSocketMessage = promiseLatch<string>();
      localWebSocketServer.once("connection", (socket, request) => {
        socket.once("message", (data) => {
          localWebSocketMessage.resolve(textDecoder.decode(bytes(data)));
        });
        socket.send("message from local server");
        localWebSocket.resolve({
          socket,
          path: request.url ?? "",
          protocol: socket.protocol,
          publicOrigin: request.headers["x-ras-relay-public-origin"] as string | undefined,
        });
      });

      const relayServer = yield* listenWebSocketServer();
      yield* Effect.addFinalizer(() => closeWebSocketServer(relayServer));
      const connected = promiseLatch<{
        readonly socket: NodeSocket.NodeWS.WebSocket;
        readonly authorization: string | undefined;
      }>();
      relayServer.once("connection", (socket, request) => {
        connected.resolve({
          socket,
          authorization: request.headers.authorization,
        });
      });

      const connector = yield* RasRelayConnector.start({
        providerKind: "ras_relay",
        connectorToken: "connector-token",
        connectorUrl: `ws://127.0.0.1:${portOf(relayServer)}/v1/ras-relay/connect/endpoint`,
        localHttpHost: "127.0.0.1",
        localHttpPort: portOf(localServer),
      });
      yield* Effect.addFinalizer(() => connector.close);

      const relay = yield* awaitTest(connected, "the connector WebSocket");
      const responseFrames = promiseLatch<ReadonlyArray<RasRelayFrame>>();
      const received: Array<RasRelayFrame> = [];
      relay.socket.on("message", (data) => {
        const next = decodeRasRelayBatch(bytes(data));
        if (!next) return;
        received.push(...next);
        if (next.some(({ message }) => message.type === "http_response_end")) {
          responseFrames.resolve(received);
        }
      });
      relay.socket.send(
        encodeRasRelayBatch([
          {
            message: {
              type: "http_request_start",
              id: "request-1",
              method: "POST",
              origin: "https://code-tunnels.ras.sh",
              path: "/e/abcdef0123456789/echo?source=relay",
              headers: [["content-type", "text/plain"]],
            },
            payload: new Uint8Array(),
          },
          {
            message: { type: "http_request_body", id: "request-1" },
            payload: textEncoder.encode("request body"),
          },
          {
            message: { type: "http_request_end", id: "request-1" },
            payload: new Uint8Array(),
          },
        ]),
      );

      expect(relay.authorization).toBe("Bearer connector-token");
      expect(yield* awaitTest(observedRequest, "the local HTTP request")).toEqual({
        path: "/e/abcdef0123456789/echo?source=relay",
        body: "request body",
        acceptEncoding: "identity",
        publicOrigin: "https://code-tunnels.ras.sh",
      });
      const frames = yield* awaitTest(responseFrames, "the relay HTTP response");
      expect(frames.map(({ message }) => message.type)).toEqual([
        "http_response_start",
        "http_response_body",
        "http_response_end",
      ]);
      expect(
        frames.find(({ message }) => message.type === "http_response_start")?.message,
      ).toMatchObject({ status: 201, headers: expect.arrayContaining([["x-relayed", "yes"]]) });
      expect(
        textDecoder.decode(
          frames.find(({ message }) => message.type === "http_response_body")?.payload,
        ),
      ).toBe("local response");

      const webSocketFrames = promiseLatch<ReadonlyArray<RasRelayFrame>>();
      const webSocketReceived: Array<RasRelayFrame> = [];
      relay.socket.on("message", (data) => {
        const next = decodeRasRelayBatch(bytes(data));
        if (!next) return;
        webSocketReceived.push(...next);
        if (next.some(({ message }) => message.type === "websocket_message")) {
          webSocketFrames.resolve(webSocketReceived);
        }
      });
      relay.socket.send(
        encodeRasRelayBatch([
          {
            message: {
              type: "websocket_open",
              id: "websocket-1",
              origin: "https://code-tunnels.ras.sh",
              path: "/e/abcdef0123456789/chat?source=relay",
              headers: [],
              protocols: ["ras-test"],
            },
            payload: new Uint8Array(),
          },
        ]),
      );
      const local = yield* awaitTest(localWebSocket, "the local WebSocket");
      expect(local.path).toBe("/e/abcdef0123456789/chat?source=relay");
      expect(local.protocol).toBe("ras-test");
      expect(local.publicOrigin).toBe("https://code-tunnels.ras.sh");
      relay.socket.send(
        encodeRasRelayBatch([
          {
            message: { type: "websocket_ready", id: "websocket-1" },
            payload: new Uint8Array(),
          },
          {
            message: { type: "websocket_message", id: "websocket-1", binary: false },
            payload: textEncoder.encode("message from relay"),
          },
        ]),
      );
      expect(yield* awaitTest(localWebSocketMessage, "the local WebSocket message")).toBe(
        "message from relay",
      );
      const relayedWebSocketFrames = yield* awaitTest(
        webSocketFrames,
        "the relayed WebSocket message",
      );
      expect(relayedWebSocketFrames.map(({ message }) => message.type)).toEqual([
        "websocket_accept",
        "websocket_message",
      ]);
      expect(textDecoder.decode(relayedWebSocketFrames[1]?.payload)).toBe(
        "message from local server",
      );
      local.socket.close();
    }).pipe(Effect.scoped),
  );

  it.live("decodes compressed local responses without forwarding stale encoding headers", () =>
    Effect.gen(function* () {
      const localRequest = promiseLatch<string | undefined>();
      const localServer = yield* listenHttp(
        NodeHttp.createServer((request, response) => {
          localRequest.resolve(request.headers["accept-encoding"]);
          response.writeHead(200, {
            "content-encoding": "gzip",
            "content-type": "text/plain",
          });
          response.end(NodeZlib.gzipSync("decoded response"));
        }),
      );
      yield* Effect.addFinalizer(() => closeHttp(localServer));
      const relayServer = yield* listenWebSocketServer();
      yield* Effect.addFinalizer(() => closeWebSocketServer(relayServer));
      const connected = promiseLatch<NodeSocket.NodeWS.WebSocket>();
      relayServer.once("connection", (socket) => connected.resolve(socket));

      const connector = yield* RasRelayConnector.start({
        providerKind: "ras_relay",
        connectorToken: "connector-token",
        connectorUrl: `ws://127.0.0.1:${portOf(relayServer)}/v1/ras-relay/connect/endpoint`,
        localHttpHost: "127.0.0.1",
        localHttpPort: portOf(localServer),
      });
      yield* Effect.addFinalizer(() => connector.close);
      const relay = yield* awaitTest(connected, "the connector WebSocket");
      const completed = promiseLatch<ReadonlyArray<RasRelayFrame>>();
      const frames: Array<RasRelayFrame> = [];
      relay.on("message", (data) => {
        const next = decodeRasRelayBatch(bytes(data));
        if (!next) return;
        frames.push(...next);
        if (next.some(({ message }) => message.type === "http_response_end")) {
          completed.resolve(frames);
        }
      });
      relay.send(
        encodeRasRelayBatch([
          {
            message: {
              type: "http_request_start",
              id: "compressed-request",
              method: "GET",
              origin: "https://code-tunnels.ras.sh",
              path: "/e/abcdef0123456789/compressed",
              headers: [["accept-encoding", "gzip"]],
            },
            payload: new Uint8Array(),
          },
          {
            message: { type: "http_request_end", id: "compressed-request" },
            payload: new Uint8Array(),
          },
        ]),
      );

      expect(yield* awaitTest(localRequest, "the compressed local request")).toBe("identity");
      const response = yield* awaitTest(completed, "the decoded response");
      const start = response.find(({ message }) => message.type === "http_response_start");
      expect(start?.message).toMatchObject({
        headers: expect.not.arrayContaining([["content-encoding", "gzip"]]),
      });
      expect(
        textDecoder.decode(
          response.find(({ message }) => message.type === "http_response_body")?.payload,
        ),
      ).toBe("decoded response");
    }).pipe(Effect.scoped),
  );

  it.live("aborts a local HTTP request when the relay cancels it", () =>
    Effect.gen(function* () {
      const localRequestStarted = promiseLatch<void>();
      const localRequestClosed = promiseLatch<void>();
      const localServer = yield* listenHttp(
        NodeHttp.createServer((request, response) => {
          localRequestStarted.resolve(undefined);
          request.once("close", () => localRequestClosed.resolve(undefined));
          response.once("close", () => localRequestClosed.resolve(undefined));
        }),
      );
      yield* Effect.addFinalizer(() => closeHttp(localServer));
      const relayServer = yield* listenWebSocketServer();
      yield* Effect.addFinalizer(() => closeWebSocketServer(relayServer));
      const connected = promiseLatch<NodeSocket.NodeWS.WebSocket>();
      relayServer.once("connection", (socket) => connected.resolve(socket));

      const connector = yield* RasRelayConnector.start({
        providerKind: "ras_relay",
        connectorToken: "connector-token",
        connectorUrl: `ws://127.0.0.1:${portOf(relayServer)}/v1/ras-relay/connect/endpoint`,
        localHttpHost: "127.0.0.1",
        localHttpPort: portOf(localServer),
      });
      yield* Effect.addFinalizer(() => connector.close);
      const relay = yield* awaitTest(connected, "the connector WebSocket");
      const received: Array<RasRelayFrame> = [];
      relay.on("message", (data) => {
        const frames = decodeRasRelayBatch(bytes(data));
        if (frames) received.push(...frames);
      });
      relay.send(
        encodeRasRelayBatch([
          {
            message: {
              type: "http_request_start",
              id: "canceled-request",
              method: "GET",
              origin: "https://code-tunnels.ras.sh",
              path: "/e/abcdef0123456789/slow",
              headers: [],
            },
            payload: new Uint8Array(),
          },
          {
            message: { type: "http_request_end", id: "canceled-request" },
            payload: new Uint8Array(),
          },
        ]),
      );
      yield* awaitTest(localRequestStarted, "the local HTTP request");

      relay.send(
        encodeRasRelayBatch([
          {
            message: { type: "http_request_cancel", id: "canceled-request" },
            payload: new Uint8Array(),
          },
        ]),
      );
      yield* awaitTest(localRequestClosed, "the canceled local HTTP request");
      yield* Effect.yieldNow;

      expect(received).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it("rejects a batch that would exceed the connector socket buffer", () => {
    expect(
      RasRelayConnector.rasRelaySocketBufferHasCapacity(RAS_RELAY_MAX_SOCKET_BUFFER_BYTES, 1),
    ).toBe(false);
  });

  it("bounds pre-ready WebSocket data across the connector", () => {
    expect(
      RasRelayConnector.rasRelayWebSocketBufferHasCapacity(0, RAS_RELAY_MAX_SOCKET_BUFFER_BYTES, 1),
    ).toBe(false);
  });

  it("accepts the advertised file attachment size", () => {
    expect(RAS_RELAY_MAX_STREAM_BYTES).toBeGreaterThanOrEqual(PROVIDER_SEND_TURN_MAX_FILE_BYTES);
  });

  it.live("closes the connector when the relay stops answering keepalive pings", () =>
    Effect.gen(function* () {
      const relayServer = yield* listenWebSocketServer({ autoPong: false });
      yield* Effect.addFinalizer(() => closeWebSocketServer(relayServer));

      const connector = yield* RasRelayConnector.start(
        {
          providerKind: "ras_relay",
          connectorToken: "connector-token",
          connectorUrl: `ws://127.0.0.1:${portOf(relayServer)}/v1/ras-relay/connect/endpoint`,
          localHttpHost: "127.0.0.1",
          localHttpPort: 1,
        },
        { keepAliveIntervalMillis: 25 },
      );
      yield* Effect.addFinalizer(() => connector.close);

      yield* connector.closed.pipe(
        Effect.timeoutOrElse({
          duration: "3 seconds",
          orElse: () => Effect.die(new Error("Connector stayed open without a pong")),
        }),
      );
      expect(yield* connector.isRunning).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live("keeps the connector open while the relay answers keepalive pings", () =>
    Effect.gen(function* () {
      const relayServer = yield* listenWebSocketServer();
      yield* Effect.addFinalizer(() => closeWebSocketServer(relayServer));

      const connector = yield* RasRelayConnector.start(
        {
          providerKind: "ras_relay",
          connectorToken: "connector-token",
          connectorUrl: `ws://127.0.0.1:${portOf(relayServer)}/v1/ras-relay/connect/endpoint`,
          localHttpHost: "127.0.0.1",
          localHttpPort: 1,
        },
        { keepAliveIntervalMillis: 25 },
      );
      yield* Effect.addFinalizer(() => connector.close);

      yield* Effect.sleep("250 millis");

      expect(yield* connector.isRunning).toBe(true);
    }).pipe(Effect.scoped),
  );
});
