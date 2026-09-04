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
  // Upstream's repository, and the forks of it named in fixtures, keep their
  // real slug; only the fork identity `t3tools/t3code` becomes ours.
  /\bpingdotgg\/t3code\b/g,
  /\bPingDotGG\/T3Code\b/g,
  /\bbinbandit\/t3code\b/g,
  /@t3dotcodes\b/g,
  // Our own workspace scope. Every package under it is private, so it never reaches a user, and
  // keeping upstream's spelling keeps their import lines identical to ours.
  /@t3tools\/[\w-]*/g,
  /\bsha512-[A-Za-z0-9+/=]+/g,
  /\bt3_relay\b/g,
  // Crosses the wire to provider agents as an ACP `_meta` key, and to clients and the relay as an
  // OAuth token-type URN. Both are asserted by their own tests, and both have been rebranded by
  // accident and repaired by hand once already.
  /\bt3SessionLoadReady\b/g,
  /\burn:t3:[\w:-]+/g,
  // The fork notice names upstream on purpose.
  /\[T3 Code\]\(https:\/\/github\.com\/pingdotgg\/t3code\)/g,
  // The WSL runtime cache still lives under these names on users' disks, so
  // renaming them here would orphan every installed runtime.
  /\$HOME\/\.t3\/wsl-runtime/g,
  /\.t3code-wsl-runtime-(?:ready|selected)\b/g,
  /\bt3code-wsl-node-pty\.json\b/g,
];

const textRules: ReadonlyArray<RebrandRule> = [
  {
    pattern: /\bt3tools\/t3code\b/gi,
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
    pattern: /T3_/g,
    replacement: "RAS_CODE_",
    description: "product identifiers nested inside delimiters",
  },
  {
    pattern: /T3Connect(?=[A-Z]|\b)/g,
    replacement: "RasConnect",
    description: "remote access product name in PascalCase identifiers",
  },
  {
    pattern: /\bt3Connect(?=[A-Z]|\b)/g,
    replacement: "rasConnect",
    description: "remote access product name in camelCase identifiers",
  },
  {
    pattern: /\bT3 Connect\b/g,
    replacement: "RAS Connect",
    description: "remote access product name",
  },
  {
    pattern: /\bt3-connect\b/g,
    replacement: "ras-connect",
    description: "remote access product name in kebab-case ids",
  },
  {
    pattern: /\bt3 connect\b/g,
    replacement: "ras connect",
    description: "remote access product name in prose and search terms",
  },
  {
    // No leading boundary: an escaped newline in a source string literal ends in
    // `n`, so `\nT3 Code` has no word boundary before the name.
    pattern: /T3 Code\b/g,
    replacement: "RAS Code",
    description: "product name",
  },
  {
    pattern: /\\nT3\b/g,
    replacement: "\\nRAS Code",
    description: "product shorthand after an escaped newline",
  },
  {
    pattern: /\bT3\b/g,
    replacement: "RAS Code",
    description: "standalone product shorthand",
  },
  {
    pattern: /T3ProjectFile/g,
    replacement: "RasProjectFile",
    description: "project file types",
  },
  {
    pattern: /\bt3ProjectFile/g,
    replacement: "rasProjectFile",
    description: "project file helpers",
  },
  {
    pattern: /\bT3Code\b/g,
    replacement: "RasCode",
    description: "PascalCase product name",
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
    pattern: /\bt3-([a-z0-9][a-z0-9-]*)/g,
    replacement: "ras-code-$1",
    description:
      "product-scoped kebab identifiers; runs after the ones that map to a different stem",
  },
  {
    pattern: /\bcom\.t3tools\./g,
    replacement: "com.richardsolomou.ras_code.",
    description: "Android Maven groups",
  },
  {
    pattern: /\bnpx t3(?=@|\b)/g,
    replacement: "npx ras-code",
    description: "package runner commands",
  },
  {
    pattern: /\bt3(?= (?:app|connect|pair|serve|service)\b)/g,
    replacement: "ras",
    description: "installed CLI commands",
  },
  {
    pattern: /\bt3\b(?!-)/g,
    replacement: "ras-code",
    description: "standalone package name",
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
  [/T3ProjectFile/g, "RasProjectFile"],
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

export interface UnmappedBrandToken {
  readonly token: string;
  readonly count: number;
}

/**
 * Brand tokens the table cannot decide, counted across every line a diff adds.
 *
 * Left to the per-file helper these surface one at a time, mid-cherry-pick, and each one costs a
 * detour to extend the table. Reading them off a whole range first turns a round's worth of
 * interruptions into one edit before any picking starts.
 */
export function collectUnmappedBrandTokensFromDiff(
  diff: string,
): ReadonlyArray<UnmappedBrandToken> {
  const counts = new Map<string, number>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const residual of findResidualBrandTokens(rebrandText(line.slice(1)))) {
      counts.set(residual.token, (counts.get(residual.token) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([token, count]) => ({ token, count }))
    .toSorted((left, right) => right.count - left.count || left.token.localeCompare(right.token));
}
