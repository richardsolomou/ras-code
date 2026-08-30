import * as Cloudflare from "alchemy/Cloudflare";
import * as Alchemy from "alchemy";
import {
  decodeRasRelayBatch,
  encodeRasRelayBatch,
  RAS_RELAY_MAX_FRAME_PAYLOAD_BYTES,
  RAS_RELAY_MAX_HTTP_RESPONSE_BUFFER_BYTES,
  RAS_RELAY_MAX_STREAM_BYTES,
  type RasRelayFrame,
} from "@ras-code/shared/rasRelayProtocol";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { makeRasRelaySession } from "./RasRelaySession.ts";

const runtimeContext = Alchemy.RuntimeContext.of({
  Type: "test",
  id: "ras-relay-session-test",
  env: {},
  get: <T>() => Effect.sync((): T | undefined => undefined),
  set: (id) => Effect.succeed(id),
});

interface FakeSocket {
  readonly socket: Cloudflare.WebSocket;
  readonly sent: Array<RasRelayFrame>;
  readonly messages: Array<string | Uint8Array>;
  readonly closes: Array<{ readonly code: number; readonly reason: string }>;
}

function fakeSocket(
  attachment: unknown,
  onFrames?: (frames: ReadonlyArray<RasRelayFrame>) => Effect.Effect<void>,
): FakeSocket {
  let storedAttachment = attachment;
  const sent: Array<RasRelayFrame> = [];
  const messages: Array<string | Uint8Array> = [];
  const closes: Array<{ readonly code: number; readonly reason: string }> = [];
  const socket: Cloudflare.WebSocket = {
    ws: {} as never,
    send: (data) => {
      if (typeof data === "string") {
        messages.push(data);
        return Effect.void;
      }
      const frames = decodeRasRelayBatch(data);
      if (!frames) {
        messages.push(data);
        return Effect.void;
      }
      sent.push(...frames);
      return onFrames ? onFrames(frames) : Effect.void;
    },
    close: (code, reason) =>
      Effect.sync(() => {
        closes.push({ code, reason });
      }),
    serializeAttachment: (value) => {
      storedAttachment = value;
    },
    deserializeAttachment: () => storedAttachment as never,
  };
  return { socket, sent, messages, closes };
}

function relayState(sockets: ReadonlyArray<Cloudflare.WebSocket>) {
  return Cloudflare.DurableObjectState.of({
    getWebSockets: () => Effect.succeed([...sockets]),
  } as unknown as Cloudflare.DurableObjectState["Service"]);
}

function makeSession(state: Cloudflare.DurableObjectState["Service"]) {
  return Effect.gen(function* () {
    const initialize = yield* makeRasRelaySession.pipe(
      Effect.provideService(Cloudflare.DurableObjectState, state),
      Effect.provideService(Alchemy.RuntimeContext, runtimeContext),
    );
    return yield* initialize.pipe(
      Effect.provideService(Cloudflare.DurableObjectState, state),
      Effect.provideService(Alchemy.RuntimeContext, runtimeContext),
    );
  });
}

function fetchSession(
  session: Effect.Success<ReturnType<typeof makeSession>>,
  state: Cloudflare.DurableObjectState["Service"],
  request: Request,
) {
  return session.fetch.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
    Effect.provideService(Cloudflare.DurableObjectState, state),
    Effect.provideService(Alchemy.RuntimeContext, runtimeContext),
  );
}

function sendToSession(
  session: Effect.Success<ReturnType<typeof makeSession>>,
  state: Cloudflare.DurableObjectState["Service"],
  socket: Cloudflare.WebSocket,
  frames: ReadonlyArray<RasRelayFrame>,
) {
  const encoded = encodeRasRelayBatch(frames);
  const message = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
  return session
    .webSocketMessage(socket, message)
    .pipe(
      Effect.provideService(Cloudflare.DurableObjectState, state),
      Effect.provideService(Alchemy.RuntimeContext, runtimeContext),
    );
}

describe("RasRelaySession", () => {
  it.effect("streams a completed HTTP response from the connector", () =>
    Effect.gen(function* () {
      const requestSent = yield* Deferred.make<string>();
      const connector = fakeSocket({ role: "connector" }, (frames) => {
        const end = frames.find(({ message }) => message.type === "http_request_end");
        return end
          ? Deferred.succeed(requestSent, end.message.id).pipe(Effect.asVoid)
          : Effect.void;
      });
      const state = relayState([connector.socket]);
      const session = yield* makeSession(state);
      const responseFiber = yield* fetchSession(
        session,
        state,
        new Request("https://code-tunnels.ras.sh/e/abcdef0123456789/api/stream"),
      ).pipe(Effect.forkChild);
      const id = yield* Deferred.await(requestSent);

      yield* sendToSession(session, state, connector.socket, [
        {
          message: {
            type: "http_response_start",
            id,
            status: 200,
            headers: [["content-type", "text/plain"]],
          },
          payload: new Uint8Array(),
        },
        {
          message: { type: "http_response_body", id },
          payload: new TextEncoder().encode("relayed response"),
        },
        {
          message: { type: "http_response_end", id },
          payload: new Uint8Array(),
        },
      ]);

      const response = HttpServerResponse.toWeb(yield* Fiber.join(responseFiber));
      expect(yield* Effect.promise(() => response.text())).toBe("relayed response");
    }),
  );

  it.effect("relays messages in both directions for a restored WebSocket", () =>
    Effect.gen(function* () {
      const connector = fakeSocket({ role: "connector" });
      const client = fakeSocket({ role: "client", id: "websocket-1" });
      const state = relayState([connector.socket, client.socket]);
      const session = yield* makeSession(state);

      yield* session
        .webSocketMessage(client.socket, "from client")
        .pipe(
          Effect.provideService(Cloudflare.DurableObjectState, state),
          Effect.provideService(Alchemy.RuntimeContext, runtimeContext),
        );
      yield* sendToSession(session, state, connector.socket, [
        {
          message: { type: "websocket_message", id: "websocket-1", binary: false },
          payload: new TextEncoder().encode("from connector"),
        },
      ]);

      expect(connector.sent.at(-1)?.message).toEqual({
        type: "websocket_message",
        id: "websocket-1",
        binary: false,
      });
      expect(client.messages).toEqual(["from connector"]);
    }),
  );

  it.effect("returns null-body responses without constructing a stream", () =>
    Effect.gen(function* () {
      const requestSent = yield* Deferred.make<string>();
      const connector = fakeSocket({ role: "connector" }, (frames) => {
        const end = frames.find(({ message }) => message.type === "http_request_end");
        return end
          ? Deferred.succeed(requestSent, end.message.id).pipe(Effect.asVoid)
          : Effect.void;
      });
      const state = relayState([connector.socket]);
      const session = yield* makeSession(state);
      const responseFiber = yield* fetchSession(
        session,
        state,
        new Request("https://code-tunnels.ras.sh/e/abcdef0123456789/api/empty"),
      ).pipe(Effect.forkChild);
      const id = yield* Deferred.await(requestSent);

      yield* sendToSession(session, state, connector.socket, [
        {
          message: { type: "http_response_start", id, status: 204, headers: [] },
          payload: new Uint8Array(),
        },
        {
          message: { type: "http_response_end", id },
          payload: new Uint8Array(),
        },
      ]);

      const response = HttpServerResponse.toWeb(yield* Fiber.join(responseFiber));
      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
    }),
  );

  it.effect("stops reading a content-length-less request at the stream limit", () =>
    Effect.gen(function* () {
      const connector = fakeSocket({ role: "connector" });
      const state = relayState([connector.socket]);
      const session = yield* makeSession(state);
      const request = new Request("https://code-tunnels.ras.sh/e/abcdef0123456789/api/upload", {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(RAS_RELAY_MAX_STREAM_BYTES));
            controller.enqueue(new Uint8Array(1));
          },
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" });

      const response = HttpServerResponse.toWeb(yield* fetchSession(session, state, request));

      expect(response.status).toBe(413);
      expect(connector.sent.at(-1)?.message.type).toBe("http_request_cancel");
    }),
  );

  it.effect("times out while a public request body is still uploading", () =>
    Effect.gen(function* () {
      const requestStarted = yield* Deferred.make<void>();
      let bodyCanceled = false;
      const connector = fakeSocket({ role: "connector" }, (frames) =>
        frames.some(({ message }) => message.type === "http_request_start")
          ? Deferred.succeed(requestStarted, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      const state = relayState([connector.socket]);
      const session = yield* makeSession(state);
      const request = new Request("https://code-tunnels.ras.sh/e/abcdef0123456789/api/upload", {
        method: "POST",
        body: new ReadableStream({
          cancel() {
            bodyCanceled = true;
          },
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const responseFiber = yield* fetchSession(session, state, request).pipe(Effect.forkChild);
      yield* Deferred.await(requestStarted);
      yield* TestClock.adjust("30 seconds");

      const response = HttpServerResponse.toWeb(yield* Fiber.join(responseFiber));
      expect(response.status).toBe(504);
      expect(bodyCanceled).toBe(true);
      expect(connector.sent.at(-1)?.message.type).toBe("http_request_cancel");
    }),
  );

  it.effect("cancels a response when the public client stops consuming", () =>
    Effect.gen(function* () {
      const requestSent = yield* Deferred.make<string>();
      const connector = fakeSocket({ role: "connector" }, (frames) => {
        const end = frames.find(({ message }) => message.type === "http_request_end");
        return end
          ? Deferred.succeed(requestSent, end.message.id).pipe(Effect.asVoid)
          : Effect.void;
      });
      const state = relayState([connector.socket]);
      const session = yield* makeSession(state);
      const responseFiber = yield* fetchSession(
        session,
        state,
        new Request("https://code-tunnels.ras.sh/e/abcdef0123456789/api/stream"),
      ).pipe(Effect.forkChild);
      const id = yield* Deferred.await(requestSent);
      yield* sendToSession(session, state, connector.socket, [
        {
          message: { type: "http_response_start", id, status: 200, headers: [] },
          payload: new Uint8Array(),
        },
      ]);
      yield* Fiber.join(responseFiber);

      const chunk = new Uint8Array(RAS_RELAY_MAX_FRAME_PAYLOAD_BYTES);
      for (
        let buffered = 0;
        buffered <= RAS_RELAY_MAX_HTTP_RESPONSE_BUFFER_BYTES;
        buffered += chunk.byteLength
      ) {
        yield* sendToSession(session, state, connector.socket, [
          {
            message: { type: "http_response_body", id },
            payload: chunk,
          },
        ]);
      }

      expect(connector.sent.at(-1)?.message).toEqual({ type: "http_request_cancel", id });
      yield* sendToSession(session, state, connector.socket, [
        {
          message: { type: "http_response_body", id },
          payload: new Uint8Array(1),
        },
        {
          message: { type: "http_response_end", id },
          payload: new Uint8Array(),
        },
      ]);
      expect(connector.closes).toEqual([]);
    }),
  );

  it.effect("cancels an HTTP request when its public request is interrupted", () =>
    Effect.gen(function* () {
      const requestSent = yield* Deferred.make<string>();
      const connector = fakeSocket({ role: "connector" }, (frames) => {
        const end = frames.find(({ message }) => message.type === "http_request_end");
        return end
          ? Deferred.succeed(requestSent, end.message.id).pipe(Effect.asVoid)
          : Effect.void;
      });
      const state = relayState([connector.socket]);
      const session = yield* makeSession(state);
      const responseFiber = yield* fetchSession(
        session,
        state,
        new Request("https://code-tunnels.ras.sh/e/abcdef0123456789/api/slow"),
      ).pipe(Effect.forkChild);
      const id = yield* Deferred.await(requestSent);

      yield* Fiber.interrupt(responseFiber);

      expect(connector.sent.at(-1)?.message).toEqual({ type: "http_request_cancel", id });
    }),
  );

  it.effect("rejects an accepted WebSocket that closes before public upgrade", () =>
    Effect.gen(function* () {
      const socketOpened = yield* Deferred.make<string>();
      const connector = fakeSocket({ role: "connector" }, (frames) => {
        const open = frames.find(({ message }) => message.type === "websocket_open");
        return open
          ? Deferred.succeed(socketOpened, open.message.id).pipe(Effect.asVoid)
          : Effect.void;
      });
      const state = relayState([connector.socket]);
      const session = yield* makeSession(state);
      const responseFiber = yield* fetchSession(
        session,
        state,
        new Request("https://code-tunnels.ras.sh/e/abcdef0123456789/ws", {
          headers: { upgrade: "websocket" },
        }),
      ).pipe(Effect.forkChild);
      const id = yield* Deferred.await(socketOpened);

      yield* sendToSession(session, state, connector.socket, [
        {
          message: { type: "websocket_accept", id },
          payload: new Uint8Array(),
        },
        {
          message: { type: "websocket_close", id, code: 1_000, reason: "done" },
          payload: new Uint8Array(),
        },
      ]);

      expect(HttpServerResponse.toWeb(yield* Fiber.join(responseFiber)).status).toBe(502);
    }),
  );

  it.effect("closes a pending WebSocket when its public request is interrupted", () =>
    Effect.gen(function* () {
      const socketOpened = yield* Deferred.make<string>();
      const connector = fakeSocket({ role: "connector" }, (frames) => {
        const open = frames.find(({ message }) => message.type === "websocket_open");
        return open
          ? Deferred.succeed(socketOpened, open.message.id).pipe(Effect.asVoid)
          : Effect.void;
      });
      const state = relayState([connector.socket]);
      const session = yield* makeSession(state);
      const responseFiber = yield* fetchSession(
        session,
        state,
        new Request("https://code-tunnels.ras.sh/e/abcdef0123456789/ws", {
          headers: { upgrade: "websocket" },
        }),
      ).pipe(Effect.forkChild);
      const id = yield* Deferred.await(socketOpened);

      yield* Fiber.interrupt(responseFiber);

      expect(connector.sent.at(-1)?.message).toEqual({
        type: "websocket_close",
        id,
        code: 1001,
        reason: "Relay request canceled",
      });
    }),
  );
});
