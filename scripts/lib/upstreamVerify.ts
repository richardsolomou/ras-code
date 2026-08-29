/**
 * Post-pick checks for the upstream sync.
 *
 * A cherry-pick that applies without conflicts still leaves the tree wrong in ways git cannot see:
 * upstream's package names survive in files that never conflicted, and upstream's directory names
 * arrive as new paths. Both compile-break or silently resurrect upstream's layout, and neither shows
 * up until a full typecheck runs, which is usually several changes later.
 */

const UPSTREAM_PACKAGE_SCOPES = ["@t3tools/", "@t3-code/"] as const;
const UPSTREAM_PATH_MARKERS = ["oxlint-plugin-t3code", "apps/t3code", "packages/t3code"] as const;

/**
 * Effect service keys upstream namespaces under `t3/`. The compiler only complains once the
 * package that owns the file is typechecked, so a pick lands and the error surfaces wherever
 * someone next runs a full check.
 */
const UPSTREAM_SERVICE_KEY = /(?:>\(\)\(|Context\.Tag\()\s*"t3\//u;

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
  readonly kind: "import" | "path" | "serviceKey";
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
    if (UPSTREAM_SERVICE_KEY.test(line)) {
      found.push({ path, line: index + 1, marker: "t3/", kind: "serviceKey" });
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
    return "No upstream residue: package scopes and directory names are all ours.";
  }
  const lines = residue.map((item) => {
    if (item.kind === "path") return `  ${item.path} — upstream path name '${item.marker}'`;
    if (item.kind === "serviceKey") {
      return `  ${item.path}:${item.line} — Effect service key namespaced '${item.marker}'`;
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
