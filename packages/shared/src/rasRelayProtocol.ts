import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Headers = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Origin = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048));
const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192));

export const RasRelayMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("http_request_start"),
    id: Id,
    method: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
    origin: Origin,
    path: Path,
    headers: Headers,
  }),
  Schema.Struct({ type: Schema.Literal("http_request_body"), id: Id }),
  Schema.Struct({ type: Schema.Literal("http_request_end"), id: Id }),
  Schema.Struct({ type: Schema.Literal("http_request_cancel"), id: Id }),
  Schema.Struct({
    type: Schema.Literal("http_response_start"),
    id: Id,
    status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
    headers: Headers,
  }),
  Schema.Struct({ type: Schema.Literal("http_response_body"), id: Id }),
  Schema.Struct({ type: Schema.Literal("http_response_end"), id: Id }),
  Schema.Struct({
    type: Schema.Literal("http_response_error"),
    id: Id,
    status: Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })),
    message: Schema.String.check(Schema.isMaxLength(1_024)),
  }),
  Schema.Struct({
    type: Schema.Literal("websocket_open"),
    id: Id,
    origin: Origin,
    path: Path,
    headers: Headers,
    protocols: Schema.Array(Schema.String.check(Schema.isMaxLength(256))),
  }),
  Schema.Struct({
    type: Schema.Literal("websocket_accept"),
    id: Id,
    protocol: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  }),
  Schema.Struct({ type: Schema.Literal("websocket_ready"), id: Id }),
  Schema.Struct({
    type: Schema.Literal("websocket_reject"),
    id: Id,
    status: Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })),
  }),
  Schema.Struct({
    type: Schema.Literal("websocket_message"),
    id: Id,
    binary: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("websocket_close"),
    id: Id,
    code: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 4_999 })),
    reason: Schema.String.check(Schema.isMaxLength(123)),
  }),
]);
export type RasRelayMessage = typeof RasRelayMessage.Type;

export interface RasRelayFrame {
  readonly message: RasRelayMessage;
  readonly payload: Uint8Array;
}

export const RAS_RELAY_MAX_BATCH_BYTES = 1_048_576;
export const RAS_RELAY_MAX_BATCH_FRAMES = 128;
export const RAS_RELAY_MAX_FRAME_METADATA_BYTES = 16_384;
export const RAS_RELAY_MAX_FRAME_PAYLOAD_BYTES = 262_144;
export const RAS_RELAY_MAX_HTTP_REQUESTS = 8;
export const RAS_RELAY_MAX_STREAM_BYTES = 16_777_216;
export const RAS_RELAY_MAX_WEBSOCKETS = 32;
export const RAS_RELAY_PUBLIC_ORIGIN_HEADER = "x-ras-relay-public-origin";

export function parseRasRelayPublicOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === origin &&
      !url.username &&
      !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

const BATCH_HEADER_BYTES = 6;
const FRAME_HEADER_BYTES = 8;
const MAGIC = new Uint8Array([0x52, 0x41, 0x53, 0x01]);
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const decodeMessage = Schema.decodeUnknownOption(RasRelayMessage);

function hasPayload(message: RasRelayMessage): boolean {
  return (
    message.type === "http_request_body" ||
    message.type === "http_response_body" ||
    message.type === "websocket_message"
  );
}

function validateFrame(frame: RasRelayFrame): void {
  if (frame.payload.byteLength > RAS_RELAY_MAX_FRAME_PAYLOAD_BYTES) {
    throw new RangeError("RAS relay frame payload exceeds its size limit");
  }
  if (!hasPayload(frame.message) && frame.payload.byteLength > 0) {
    throw new RangeError("RAS relay control frame cannot carry a payload");
  }
}

export function encodeRasRelayBatch(frames: ReadonlyArray<RasRelayFrame>): Uint8Array {
  if (frames.length === 0 || frames.length > RAS_RELAY_MAX_BATCH_FRAMES) {
    throw new RangeError("RAS relay batch has an invalid frame count");
  }
  const encoded = frames.map((frame) => {
    validateFrame(frame);
    const metadata = textEncoder.encode(JSON.stringify(frame.message));
    if (metadata.byteLength > RAS_RELAY_MAX_FRAME_METADATA_BYTES) {
      throw new RangeError("RAS relay frame metadata exceeds its size limit");
    }
    return { frame, metadata };
  });
  const byteLength = encoded.reduce(
    (total, entry) =>
      total + FRAME_HEADER_BYTES + entry.metadata.byteLength + entry.frame.payload.byteLength,
    BATCH_HEADER_BYTES,
  );
  if (byteLength > RAS_RELAY_MAX_BATCH_BYTES) {
    throw new RangeError("RAS relay batch exceeds its size limit");
  }

  const output = new Uint8Array(byteLength);
  output.set(MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint16(4, encoded.length);
  let offset = BATCH_HEADER_BYTES;
  for (const { frame, metadata } of encoded) {
    view.setUint32(offset, metadata.byteLength);
    view.setUint32(offset + 4, frame.payload.byteLength);
    offset += FRAME_HEADER_BYTES;
    output.set(metadata, offset);
    offset += metadata.byteLength;
    output.set(frame.payload, offset);
    offset += frame.payload.byteLength;
  }
  return output;
}

export function decodeRasRelayBatch(
  input: ArrayBuffer | Uint8Array,
): ReadonlyArray<RasRelayFrame> | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < BATCH_HEADER_BYTES || bytes.byteLength > RAS_RELAY_MAX_BATCH_BYTES) {
    return null;
  }
  if (MAGIC.some((value, index) => bytes[index] !== value)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameCount = view.getUint16(4);
  if (frameCount === 0 || frameCount > RAS_RELAY_MAX_BATCH_FRAMES) {
    return null;
  }

  const frames: Array<RasRelayFrame> = [];
  let offset = BATCH_HEADER_BYTES;
  for (let index = 0; index < frameCount; index += 1) {
    if (offset + FRAME_HEADER_BYTES > bytes.byteLength) {
      return null;
    }
    const metadataLength = view.getUint32(offset);
    const payloadLength = view.getUint32(offset + 4);
    offset += FRAME_HEADER_BYTES;
    if (
      metadataLength > RAS_RELAY_MAX_FRAME_METADATA_BYTES ||
      payloadLength > RAS_RELAY_MAX_FRAME_PAYLOAD_BYTES ||
      offset + metadataLength + payloadLength > bytes.byteLength
    ) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(textDecoder.decode(bytes.subarray(offset, offset + metadataLength)));
    } catch {
      return null;
    }
    offset += metadataLength;
    const decoded = decodeMessage(parsed);
    if (Option.isNone(decoded)) {
      return null;
    }
    const payload = bytes.slice(offset, offset + payloadLength);
    offset += payloadLength;
    if (!hasPayload(decoded.value) && payload.byteLength > 0) {
      return null;
    }
    frames.push({ message: decoded.value, payload });
  }
  return offset === bytes.byteLength ? frames : null;
}
