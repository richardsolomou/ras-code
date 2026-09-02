/**
 * Post-pick checks for the upstream sync.
 *
 * A cherry-pick that applies without conflicts still leaves the tree wrong in ways git cannot see:
 * upstream's package names survive in files that never conflicted, upstream's identifier namespaces
 * survive inside string literals, and upstream's directory names arrive as new paths. These
 * compile-break, silently resurrect upstream's layout, or simply never surface, and none of them
 * shows up until a full typecheck runs, which is usually several changes later.
 */

const UPSTREAM_PACKAGE_SCOPES = ["@t3tools/", "@t3-code/"] as const;
const UPSTREAM_PATH_MARKERS = [
  "oxlint-plugin-t3code",
  "apps/t3code",
  "packages/t3code",
  "apps/mobile/modules/t3-",
  ".agents/skills/test-t3-",
] as const;

/**
 * Identifier namespaces upstream scopes under `t3.` or `t3/`: Effect service keys, atom runtime
 * ids, `Symbol.for` keys. Nothing complains until the owning package is typechecked, or never, so
 * a pick lands and the upstream name stays. Upstream hosts and AWS instance types spell `t3.` too,
 * so a hit needs a second namespace segment.
 */
const UPSTREAM_NAMESPACE = /["'`]t3[./][a-z][\w-]*[./]/u;

/**
 * Files whose contents are *supposed* to name upstream, so a hit there is correct rather than a
 * leftover. The rebrand map's own fixtures are the main one: rewriting them breaks the map.
 */
const CONTENT_EXEMPT_SUFFIXES = [
  "scripts/lib/upstreamRebrandMap.ts",
  "scripts/lib/upstreamRebrandMap.test.ts",
  "scripts/lib/upstreamVerify.ts",
  "scripts/lib/upstreamVerify.test.ts",
] as const;

export interface UpstreamResidue {
  readonly path: string;
  readonly line: number;
  readonly marker: string;
  readonly kind: "import" | "path" | "namespace";
}

export function isContentExempt(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return CONTENT_EXEMPT_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** Upstream package scopes left in a file the rebrand never visited. */
export function findImportResidue(path: string, contents: string): ReadonlyArray<UpstreamResidue> {
  if (isContentExempt(path)) return [];
  const found: Array<UpstreamResidue> = [];
  contents.split("\n").forEach((line, index) => {
    for (const marker of UPSTREAM_PACKAGE_SCOPES) {
      if (line.includes(marker)) {
        found.push({ path, line: index + 1, marker, kind: "import" });
      }
    }
    if (UPSTREAM_NAMESPACE.test(line)) {
      found.push({ path, line: index + 1, marker: "t3.", kind: "namespace" });
    }
  });
  return found;
}

/**
 * Upstream directory names that arrived as tracked paths. These do not conflict — git just adds the
 * new path — so nothing flags them until someone notices two plugin directories.
 */
export function findPathResidue(paths: ReadonlyArray<string>): ReadonlyArray<UpstreamResidue> {
  const found: Array<UpstreamResidue> = [];
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/");
    if (isContentExempt(normalized)) continue;
    for (const marker of UPSTREAM_PATH_MARKERS) {
      if (normalized.includes(marker)) {
        found.push({ path: normalized, line: 0, marker, kind: "path" });
      }
    }
  }
  return found;
}

export function formatResidue(residue: ReadonlyArray<UpstreamResidue>): string {
  if (residue.length === 0) {
    return "No upstream residue: package scopes, identifier namespaces, and directory names are all ours.";
  }
  const lines = residue.map((item) => {
    if (item.kind === "path") return `  ${item.path} — upstream path name '${item.marker}'`;
    if (item.kind === "namespace") {
      return `  ${item.path}:${item.line} — identifier namespaced under upstream '${item.marker}'`;
    }
    return `  ${item.path}:${item.line} — upstream package scope '${item.marker}'`;
  });
  return [
    `Found ${residue.length} upstream leftover${residue.length === 1 ? "" : "s"}:`,
    ...lines,
    "",
    "Run `node scripts/upstream-rebrand.ts <files>` on the content hits, and move or delete the path hits.",
  ].join("\n");
}

/**
 * Packages a fork-only file imports but its manifest no longer declares.
 *
 * Upstream prunes dependencies against upstream's own code, so a removal that is correct there can
 * still be wrong here: the fork carries files upstream has never seen. #9150 dropped
 * `@effect/platform-node-shared`, which only the fork-only relay connector imports, and the pick
 * was read and adapted without anyone noticing. Nothing failed until `node_modules` was reinstalled
 * from the merged lockfile, several changes and one CI round-trip later.
 */
export interface UndeclaredForkDependency {
  readonly path: string;
  readonly line: number;
  readonly packageName: string;
}

const RELATIVE_SPECIFIER = /^[./]/u;
const ALIAS_SPECIFIER = /^[~#]/u;
/**
 * Import statements only, anchored at the start of a line: `from "..."` also appears in prose and
 * in template literals, and a doc comment is not a dependency. The `}` alternative catches the
 * closing line of a multi-line named import, where `from` is no longer beside `import`.
 */
const IMPORT_SPECIFIER = new RegExp(
  [
    /^[ \t]*(?:import|export)\b[^"'\n]*\bfrom[ \t]*["']([^"'\n]+)["']/u.source,
    /^[ \t]*\}[ \t]*from[ \t]*["']([^"'\n]+)["']/u.source,
    /^[ \t]*(?:import|export)[ \t]+["']([^"'\n]+)["']/u.source,
    /(?:\brequire|\bimport)[ \t]*\([ \t]*["']([^"'\n]+)["'][ \t]*\)/u.source,
  ].join("|"),
  "gmu",
);

/**
 * The package a specifier belongs to, or `null` for anything a manifest never declares: relative
 * paths, absolute paths, and Node builtins with or without the `node:` prefix.
 */
export function packageNameFromSpecifier(specifier: string): string | null {
  if (specifier.length === 0 || RELATIVE_SPECIFIER.test(specifier)) return null;
  if (specifier.startsWith("node:")) return null;
  // `~/…` and `#…` are tsconfig path aliases, and an interpolated specifier is not a package name.
  if (ALIAS_SPECIFIER.test(specifier) || specifier.includes("${")) return null;
  const segments = specifier.split("/");
  const name = specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : (segments[0] ?? specifier);
  if (name.startsWith("@") && segments.length < 2) return null;
  return NODE_BUILTINS.has(name) ? null : name;
}

const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);

/** Every external package a source file imports, with the line that imports it. */
export function findExternalImports(
  contents: string,
): ReadonlyArray<{ readonly packageName: string; readonly line: number }> {
  const found: Array<{ packageName: string; line: number }> = [];
  const seen = new Set<string>();
  const scanner = new RegExp(IMPORT_SPECIFIER.source, IMPORT_SPECIFIER.flags);
  for (let match = scanner.exec(contents); match !== null; match = scanner.exec(contents)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!specifier) continue;
    const packageName = packageNameFromSpecifier(specifier);
    if (packageName === null || seen.has(packageName)) continue;
    seen.add(packageName);
    found.push({
      packageName,
      line: contents.slice(0, match.index).split("\n").length,
    });
  }
  return found;
}

/** Every dependency field a manifest can declare, flattened to the names pnpm will resolve. */
export function collectDeclaredDependencies(manifest: unknown): ReadonlySet<string> {
  const record = (manifest ?? {}) as Record<string, unknown>;
  const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const declared = new Set<string>();
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== "object" || value === null) continue;
    for (const name of Object.keys(value as Record<string, unknown>)) declared.add(name);
  }
  return declared;
}

/**
 * Fork-only imports no manifest covers. `declaredFor` answers with the names visible to a file,
 * which is its own package's manifest plus the workspace root's.
 */
export function findUndeclaredForkDependencies(
  files: ReadonlyArray<{ readonly path: string; readonly contents: string }>,
  declaredFor: (path: string) => ReadonlySet<string>,
): ReadonlyArray<UndeclaredForkDependency> {
  const found: Array<UndeclaredForkDependency> = [];
  for (const file of files) {
    if (isContentExempt(file.path)) continue;
    const declared = declaredFor(file.path);
    for (const imported of findExternalImports(file.contents)) {
      if (declared.has(imported.packageName)) continue;
      found.push({
        path: file.path,
        line: imported.line,
        packageName: imported.packageName,
      });
    }
  }
  return found;
}

export function formatUndeclaredForkDependencies(
  undeclared: ReadonlyArray<UndeclaredForkDependency>,
): string {
  if (undeclared.length === 0) {
    return "No fork-only file imports a package its manifest has stopped declaring.";
  }
  const byPackage = new Map<string, Array<UndeclaredForkDependency>>();
  for (const item of undeclared) {
    const bucket = byPackage.get(item.packageName);
    if (bucket) bucket.push(item);
    else byPackage.set(item.packageName, [item]);
  }
  const lines = [...byPackage].map(([packageName, items]) => {
    const sites = items.map((item) => `${item.path}:${item.line}`).join(", ");
    return `  ${packageName} — imported by ${sites}`;
  });
  return [
    `Found ${byPackage.size} undeclared fork-only dependenc${byPackage.size === 1 ? "y" : "ies"}:`,
    ...lines,
    "",
    "Upstream prunes against upstream's code. Re-declare these, or move the fork-only importer.",
  ].join("\n");
}
