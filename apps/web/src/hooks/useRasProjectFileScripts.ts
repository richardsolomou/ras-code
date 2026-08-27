import {
  RAS_PROJECT_FILE_NAME,
  type EnvironmentId,
  type RasProjectFile,
  type RasProjectFileScript,
} from "@ras-code/contracts";
import { parseRasProjectFile } from "@ras-code/shared/rasProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<RasProjectFileScript> = [];

export interface RasProjectFileState {
  /**
   * - `valid`: ras.json exists and decoded.
   * - `invalid`: ras.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable ras.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: RasProjectFile | null;
  scripts: ReadonlyArray<RasProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `ras.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useRasProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): RasProjectFileState {
  const query = useProjectFileQuery(environmentId, cwd ?? "", RAS_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseRasProjectFile(contents);
    if (file === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}

/**
 * Scripts declared in the project's checked-in `ras.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useRasProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<RasProjectFileScript> {
  return useRasProjectFileState(environmentId, cwd).scripts;
}
