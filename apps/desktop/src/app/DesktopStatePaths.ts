import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(rasCodeHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(rasCodeHome)) {
    return Option.none();
  }
  const trimmed = rasCodeHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly rasCodeHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.rasCodeHome), () =>
    input.joinPath(input.homeDirectory, ".ras-code"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly rasCodeHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.rasCodeHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
