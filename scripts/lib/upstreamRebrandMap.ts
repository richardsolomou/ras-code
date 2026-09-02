/**
 * Single source of truth for the RAS Code rebrand vocabulary.
 *
 * `rebrandText` rewrites upstream (T3 Code) text into our vocabulary so a cherry-picked upstream
 * diff lands with our identifiers. `mapUpstreamPath` does the same for file paths. Both are
 * assistive: they turn mechanical differences into clean applies, they do not resolve semantic
 * conflicts. `findResidualBrandTokens` reports whatever the table could not decide.
 */

export interface RebrandRule {
  readonly pattern: RegExp;
  readonly replacement: string;
  readonly description: string;
}

/**
 * Spans that keep their upstream spelling. They are matched before any rule runs and copied
 * through untouched: wire-visible strings, upstream hosts, upstream repository URLs, and the
 * legacy theme ids we still honour for stored settings.
 */
export const preservedPatterns: ReadonlyArray<RegExp> = [
  /\.well-known\/t3\/[\w-]+/g,
  /refs\/t3\/[\w-]+/g,
  /\bt3-chat-dark\b/g,
  /\bt3-chat\b/g,
  /\b[\w-]*\.?t3\.(?:codes|chat|tools|sh)\b/g,
  /\bt3\.(?:nano|micro|small|medium|large|xlarge|\d+xlarge)\b/g,
  /\bpingdotgg\/t3code\b/g,
  /\bt3_relay\b/g,
];

const textRules: ReadonlyArray<RebrandRule> = [
  {
    pattern: /@t3tools\//g,
    replacement: "@ras-code/",
    description: "workspace package scope",
  },
  {
    pattern: /\bt3tools\/t3code\b/g,
    replacement: "richardsolomou/ras-code",
    description: "fork repository slug",
  },
  {
    pattern: /\boxlint-plugin-t3code\b/g,
    replacement: "oxlint-plugin-ras-code",
    description: "local oxlint plugin",
  },
  {
    pattern: /\bT3CODE_/g,
    replacement: "RAS_CODE_",
    description: "product-scoped environment variables",
  },
  {
    pattern: /\bLEGACY_T3_CHAT_DARK_THEME_ID\b/g,
    replacement: "LEGACY_DARK_DEFAULT_THEME_ID",
    description: "legacy dark theme id constant",
  },
  {
    pattern: /\bLEGACY_T3_CHAT_THEME_ID\b/g,
    replacement: "LEGACY_DEFAULT_THEME_ID",
    description: "legacy theme id constant",
  },
  {
    pattern: /T3_CHAT_THEME/g,
    replacement: "RAS_CODE_THEME",
    description: "default theme constants",
  },
  {
    pattern:
      /T3_(BOOT_SERVICE_UNIT|SERVICE_LAUNCHER_CONTEXT|CLOUD_DEBUG|TERMINAL_DEBUG|FILE_ICON_SPRITE|PIERRE_ICONS|HOME|SHOWCASE_)/g,
    replacement: "RAS_CODE_$1",
    description: "identifiers we widened to the RAS_CODE_ prefix",
  },
  {
    pattern: /\bT3_/g,
    replacement: "RAS_",
    description: "remaining screaming-snake identifiers",
  },
  {
    pattern: /\bT3 Connect\b/g,
    replacement: "RAS Connect",
    description: "remote access product name",
  },
  {
    pattern: /\bT3 Code\b/g,
    replacement: "RAS Code",
    description: "product name",
  },
  {
    pattern: /\bT3ProjectFile/g,
    replacement: "RasProjectFile",
    description: "project file types",
  },
  {
    pattern: /\bt3ProjectFile/g,
    replacement: "rasProjectFile",
    description: "project file helpers",
  },
  {
    pattern: /T3(?=[A-Z])/g,
    replacement: "RasCode",
    description: "PascalCase identifiers",
  },
  {
    pattern: /\bfont-t3-/g,
    replacement: "font-ras-code-",
    description: "font family classes",
  },
  {
    pattern: /--t3-/g,
    replacement: "--ras-code-",
    description: "CSS custom properties",
  },
  {
    pattern: /\bt3\.json\b/g,
    replacement: "ras.json",
    description: "project file name",
  },
  {
    pattern: /expo\.modules\.t3(composereditor|markdowntext|nativecontrols|reviewdiff|terminal)\b/g,
    replacement: "expo.modules.ras_code.$1",
    description: "Android package names",
  },
  {
    pattern:
      /\bt3-(composer-editor|markdown-text|native-controls|review-diff|terminal|composer-attachments|attachment-downloads)\b/g,
    replacement: "ras-code-$1",
    description: "mobile native module and on-device data directories",
  },
  {
    pattern: /\bt3-sqlite-state\b/g,
    replacement: "ras-sqlite-state",
    description: "server state script",
  },
  {
    pattern: /\bt3code\b/g,
    replacement: "ras-code",
    description: "kebab-case product id",
  },
  {
    pattern: /\bt3-code\b/g,
    replacement: "ras-code",
    description: "kebab-case product id",
  },
  {
    pattern: /\bt3_session/g,
    replacement: "ras_session",
    description: "browser session cookie name",
  },
  {
    pattern: /\bt3_/g,
    replacement: "ras_code_",
    description: "snake_case identifiers",
  },
  {
    pattern: /(?<=["'`])t3(?=[./][a-z])/g,
    replacement: "ras-code",
    description: "product-scoped identifier namespaces in string literals",
  },
  {
    pattern: /~\/\.t3\b/g,
    replacement: "~/.ras-code",
    description: "home directory",
  },
  {
    pattern: /(^|[^\w.])\.t3(?![.\w-])/g,
    replacement: "$1.ras-code",
    description: "state directory",
  },
  {
    pattern: /\bt3Code(?=[A-Z]|\b)/g,
    replacement: "rasCode",
    description: "camelCase identifiers that already carry Code",
  },
  {
    pattern: /\bt3(?=[A-Z])/g,
    replacement: "rasCode",
    description: "camelCase identifiers",
  },
];

export const rebrandRules: ReadonlyArray<RebrandRule> = textRules;

const preservedScanner = new RegExp(
  preservedPatterns.map((pattern) => `(?:${pattern.source})`).join("|"),
  "g",
);

const applyRules = (input: string): string =>
  textRules.reduce(
    (text, rule) =>
      text.replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.replacement),
    input,
  );

/** Rewrites upstream vocabulary into ours, leaving `preservedPatterns` spans untouched. */
export function rebrandText(input: string): string {
  const scanner = new RegExp(preservedScanner.source, "g");
  let result = "";
  let cursor = 0;

  for (let match = scanner.exec(input); match !== null; match = scanner.exec(input)) {
    result += applyRules(input.slice(cursor, match.index)) + match[0];
    cursor = match.index + match[0].length;
  }

  return result + applyRules(input.slice(cursor));
}

const directoryRenames: ReadonlyArray<readonly [string, string]> = [
  [".agents/skills/test-t3-app/", ".agents/skills/test-ras-app/"],
  [".agents/skills/test-t3-mobile/", ".agents/skills/test-ras-mobile/"],
  ["apps/mobile/modules/t3-composer-editor/", "apps/mobile/modules/ras-code-composer-editor/"],
  ["apps/mobile/modules/t3-markdown-text/", "apps/mobile/modules/ras-code-markdown-text/"],
  ["apps/mobile/modules/t3-native-controls/", "apps/mobile/modules/ras-code-native-controls/"],
  ["apps/mobile/modules/t3-review-diff/", "apps/mobile/modules/ras-code-review-diff/"],
  ["apps/mobile/modules/t3-terminal/", "apps/mobile/modules/ras-code-terminal/"],
  ["oxlint-plugin-t3code/", "oxlint-plugin-ras-code/"],
  ["packaging/aur/t3code-bin/", "packaging/aur/ras-code-bin/"],
  ["packaging/aur/t3code-nightly-bin/", "packaging/aur/ras-code-canary-bin/"],
];

const pathRules: ReadonlyArray<readonly [RegExp, string]> = [
  [/^t3\.json$/, "ras.json"],
  [/\bt3-connect\b/, "ras-connect"],
  [/\bt3-code-connect-auth-flow\b/, "ras-code-connect-auth-flow"],
  [/\bT3ProjectFile/g, "RasProjectFile"],
  [/\bt3ProjectFile/g, "rasProjectFile"],
  [
    /expo\/modules\/t3(composereditor|markdowntext|nativecontrols|reviewdiff|terminal)\b/g,
    "expo/modules/ras_code/$1",
  ],
  [/\bt3-sqlite-state\b/g, "ras-sqlite-state"],
  [/\bt3_/g, "ras_code_"],
  [/T3(?=[A-Z])/g, "RasCode"],
];

/**
 * Maps an upstream repository path onto its RAS Code path. Paths we never renamed — which is most
 * of the tree — come back unchanged.
 */
export function mapUpstreamPath(path: string): string {
  const withDirectory = directoryRenames.reduce(
    (current, [from, to]) => (current.startsWith(from) ? to + current.slice(from.length) : current),
    path,
  );

  return pathRules.reduce((current, [pattern, replacement]) => {
    return current.replace(new RegExp(pattern.source, pattern.flags), replacement);
  }, withDirectory);
}

export interface ResidualBrandToken {
  readonly line: number;
  readonly token: string;
}

// Two alternatives so `Uint32` and friends do not read as brand tokens: a lowercase `t3` only
// counts at a token start, an uppercase `T3` counts anywhere inside an identifier.
const residualScanner = /(?:^|[^A-Za-z0-9])(@?t3[\w./-]*)|([A-Za-z_]*T3[\w./-]*)/g;

/**
 * Reports upstream brand tokens the table left behind, so a human decides them. Preserved spans are
 * deliberate and are not reported.
 */
export function findResidualBrandTokens(input: string): ReadonlyArray<ResidualBrandToken> {
  const preserved = new RegExp(preservedScanner.source, "g");
  const residuals: Array<ResidualBrandToken> = [];

  input.split("\n").forEach((line, index) => {
    const masked = line.replace(preserved, "");
    const scanner = new RegExp(residualScanner.source, "g");
    for (let match = scanner.exec(masked); match !== null; match = scanner.exec(masked)) {
      const token = match[1] ?? match[2];
      if (token) {
        residuals.push({ line: index + 1, token });
      }
    }
  });

  return residuals;
}

const DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/;

/** Rewrites the path headers of a patch so it addresses our tree. Bodies are untouched. */
export function mapPatchPaths(patch: string): string {
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git a/")) {
        const match = DIFF_HEADER.exec(line);
        return match
          ? `diff --git a/${mapUpstreamPath(match[1]!)} b/${mapUpstreamPath(match[2]!)}`
          : line;
      }
      if (line.startsWith("--- a/")) {
        return `--- a/${mapUpstreamPath(line.slice(6))}`;
      }
      if (line.startsWith("+++ b/")) {
        return `+++ b/${mapUpstreamPath(line.slice(6))}`;
      }
      if (line.startsWith("rename from ")) {
        return `rename from ${mapUpstreamPath(line.slice(12))}`;
      }
      if (line.startsWith("rename to ")) {
        return `rename to ${mapUpstreamPath(line.slice(10))}`;
      }
      return line;
    })
    .join("\n");
}

const isPatchBodyLine = (line: string) =>
  (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-")) &&
  !line.startsWith("+++ ") &&
  !line.startsWith("--- ");

/**
 * Rewrites the upstream side of a patch into our vocabulary: paths in the headers, brand tokens in
 * the context and change lines. Hunk headers and blob ids stay untouched so `--3way` still works.
 */
export function rebrandPatch(patch: string): string {
  return mapPatchPaths(patch)
    .split("\n")
    .map((line) => (isPatchBodyLine(line) ? line[0] + rebrandText(line.slice(1)) : line))
    .join("\n");
}
