import type { ServerConfig } from "@ras-code/contracts";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { ConnectionAttemptStage, NetworkStatus, SupervisorConnectionState } from "./model.ts";

export type EnvironmentConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error";

export interface EnvironmentConnectionPresentation {
  readonly phase: EnvironmentConnectionPhase;
  /** Live progress of the in-flight attempt; null outside an attempt. */
  readonly stage: ConnectionAttemptStage | null;
  readonly error: string | null;
  readonly traceId: string | null;
}

export interface EnvironmentPresentation {
  readonly entry: ConnectionCatalogEntry;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: ServerConfig | null;
}

export function presentConnectionState(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  switch (state.phase) {
    case "available":
      return { phase: "available", stage: null, error: null, traceId: null };
    case "offline":
      return { phase: "offline", stage: null, error: null, traceId: null };
    case "connecting":
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        stage: state.stage,
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "connected":
      return { phase: "connected", stage: null, error: null, traceId: null };
    case "backoff":
      return {
        phase: "reconnecting",
        stage: null,
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "blocked":
      return {
        phase: "error",
        stage: null,
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
  }
}

/** Live label for an in-flight attempt, so a slow connect reads as progress. */
export function connectionStageText(stage: ConnectionAttemptStage): string {
  switch (stage) {
    case "preparing":
      return "Authorizing...";
    case "opening":
      return "Opening a connection...";
    case "synchronizing":
      return "Syncing...";
  }
}

export function connectionStatusText(connection: EnvironmentConnectionPresentation): string {
  switch (connection.phase) {
    case "available":
      return "Available";
    case "offline":
      return "Offline";
    case "connecting":
      return connection.stage ? connectionStageText(connection.stage) : "Connecting...";
    case "reconnecting":
      if (connection.error) {
        return `Failed to connect. Reconnecting... Reason: ${connection.error}`;
      }
      return connection.stage ? connectionStageText(connection.stage) : "Reconnecting...";
    case "connected":
      return "Connected";
    case "error":
      return connection.error
        ? `Connection failed. Reason: ${connection.error}`
        : "Connection failed";
  }
}

export function connectionStatusTitle(connection: EnvironmentConnectionPresentation): string {
  if (connection.phase === "reconnecting" && connection.error) {
    return "Failed to connect. Reconnecting...";
  }
  return connectionStatusText({ ...connection, error: null });
}

export function presentEnvironmentConnection(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  return presentConnectionState(state);
}

export function connectionCatalogDisplayUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : null;
    case "SshConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "SshConnectionProfile"
        ? `${entry.profile.value.target.username}@${entry.profile.value.target.hostname}`
        : null;
  }
}

export function connectionPhaseMessage(
  phase: EnvironmentConnectionPhase,
  label: string,
  networkStatus: NetworkStatus,
  stage?: ConnectionAttemptStage | null,
): string {
  if (networkStatus === "offline" || phase === "offline") {
    return "You are offline";
  }
  switch (phase) {
    case "available":
      return "Available";
    case "connecting":
    case "reconnecting":
      switch (stage) {
        case "preparing":
          return `Authorizing with ${label}...`;
        case "synchronizing":
          return `Syncing with ${label}...`;
        default:
          return phase === "connecting"
            ? `Connecting to ${label}...`
            : `Reconnecting to ${label}...`;
      }
    case "connected":
      return "Connected";
    case "error":
      return "Connection failed";
  }
}
