import { describe, expect, it } from "vite-plus/test";

import {
  collectDeclaredDependencies,
  findExternalImports,
  findImportResidue,
  findPathResidue,
  findUndeclaredForkDependencies,
  formatResidue,
  formatUndeclaredForkDependencies,
  isContentExempt,
  packageNameFromSpecifier,
} from "./upstreamVerify.ts";

describe("findImportResidue", () => {
  it("reports an upstream package scope a clean cherry-pick carried in", () => {
    const found = findImportResidue(
      "apps/web/src/state/attachments.ts",
      'import { EnvironmentId } from "@t3tools/contracts";\n',
    );
    expect(found).toEqual([
      { path: "apps/web/src/state/attachments.ts", line: 1, marker: "@t3tools/", kind: "import" },
    ]);
  });

  it("reports the line so the file does not have to be searched by hand", () => {
    const found = findImportResidue(
      "a.ts",
      ['import { a } from "./a";', "", 'import { b } from "@t3-code/shared/b";'].join("\n"),
    );
    expect(found[0]?.line).toBe(3);
  });

  it("leaves our own package scope alone", () => {
    expect(findImportResidue("a.ts", 'import { a } from "@ras-code/shared/a";')).toEqual([]);
  });

  it("spares the rebrand map, whose fixtures name upstream on purpose", () => {
    expect(
      findImportResidue("scripts/lib/upstreamRebrandMap.test.ts", 'x = "@t3tools/contracts";'),
    ).toEqual([]);
  });
});

describe("findImportResidue, identifier namespaces", () => {
  it("catches an Effect service key still namespaced under upstream", () => {
    const found = findImportResidue(
      "apps/server/src/provider/OpenCodeServerOwner.ts",
      '>()("t3/provider/OpenCodeServerOwner") {}',
    );
    expect(found).toEqual([
      {
        path: "apps/server/src/provider/OpenCodeServerOwner.ts",
        line: 1,
        marker: "t3.",
        kind: "namespace",
      },
    ]);
  });

  it("catches a dotted namespace on a line with no service-key constructor", () => {
    expect(
      findImportResidue("a.ts", '  const key = Symbol.for("t3.mobile.hot-atom-runtimes");'),
    ).toEqual([{ path: "a.ts", line: 1, marker: "t3.", kind: "namespace" }]);
  });

  it("leaves our own namespace alone", () => {
    expect(findImportResidue("a.ts", '>()("ras-code/provider/OpenCodeServerOwner") {}')).toEqual(
      [],
    );
  });

  it("does not fire on the do-not-rename wire paths that legitimately say t3", () => {
    expect(findImportResidue("a.ts", 'const path = "/.well-known/t3/environment";')).toEqual([]);
    expect(findImportResidue("a.ts", 'const ref = "refs/t3/checkpoints";')).toEqual([]);
  });

  it("does not fire on upstream hosts or instance types, which have no second segment", () => {
    expect(findImportResidue("a.ts", 'const url = "t3.chat";')).toEqual([]);
    expect(findImportResidue("a.ts", 'const size = "t3.micro";')).toEqual([]);
  });
});

describe("findPathResidue", () => {
  it("catches a renamed directory that git could not follow", () => {
    expect(
      findPathResidue(["apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorModule.swift"]),
    ).toEqual([
      {
        path: "apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorModule.swift",
        line: 0,
        marker: "apps/mobile/modules/t3-",
        kind: "path",
      },
    ]);
  });

  it("catches an upstream directory that arrived as a new path", () => {
    expect(findPathResidue(["oxlint-plugin-t3code/rules/no-escape-hatches.ts"])).toEqual([
      {
        path: "oxlint-plugin-t3code/rules/no-escape-hatches.ts",
        line: 0,
        marker: "oxlint-plugin-t3code",
        kind: "path",
      },
    ]);
  });

  it("leaves our equivalent directory alone", () => {
    expect(findPathResidue(["oxlint-plugin-ras-code/rules/no-escape-hatches.ts"])).toEqual([]);
  });
});

describe("isContentExempt", () => {
  it("exempts the rebrand map itself", () => {
    expect(isContentExempt("scripts/lib/upstreamRebrandMap.ts")).toBe(true);
  });

  it("exempts nothing else", () => {
    expect(isContentExempt("apps/web/src/rebrandMap.ts")).toBe(false);
  });
});

describe("formatResidue", () => {
  it("says so plainly when the tree is clean", () => {
    expect(formatResidue([])).toContain("No upstream residue");
  });

  it("names the remedy for each kind of hit", () => {
    const report = formatResidue([
      { path: "a.ts", line: 3, marker: "@t3tools/", kind: "import" },
      { path: "oxlint-plugin-t3code/x.ts", line: 0, marker: "oxlint-plugin-t3code", kind: "path" },
    ]);
    expect(report).toContain("a.ts:3");
    expect(report).toContain("upstream path name");
    expect(report).toContain("upstream-rebrand.ts");
  });
});

describe("packageNameFromSpecifier", () => {
  it("keeps both segments of a scoped package so a subpath does not become the name", () => {
    expect(packageNameFromSpecifier("@effect/platform-node-shared/NodeSocket")).toBe(
      "@effect/platform-node-shared",
    );
  });

  it("drops the subpath of an unscoped package", () => {
    expect(packageNameFromSpecifier("expo-router/entry")).toBe("expo-router");
  });

  it("ignores relative imports, which no manifest declares", () => {
    expect(packageNameFromSpecifier("./RasRelayConnector.ts")).toBeNull();
  });

  it("ignores prefixed Node builtins", () => {
    expect(packageNameFromSpecifier("node:child_process")).toBeNull();
  });

  it("ignores bare Node builtins", () => {
    expect(packageNameFromSpecifier("crypto")).toBeNull();
  });
});

describe("findExternalImports", () => {
  it("reports the line so the importer does not have to be searched by hand", () => {
    const found = findExternalImports('import * as A from "node:fs";\nimport B from "ws";\n');
    expect(found).toStrictEqual([{ packageName: "ws", line: 2 }]);
  });

  it("counts a package once however many times it is imported", () => {
    const found = findExternalImports(
      'import A from "effect/Effect";\nimport B from "effect/Schema";\n',
    );
    expect(found).toStrictEqual([{ packageName: "effect", line: 1 }]);
  });

  it("sees re-exports, which import a package without naming a binding", () => {
    const found = findExternalImports('export { Socket } from "@effect/platform-node";\n');
    expect(found).toStrictEqual([{ packageName: "@effect/platform-node", line: 1 }]);
  });

  it("sees a bare side-effect import", () => {
    const found = findExternalImports('import "react-native-gesture-handler";\n');
    expect(found).toStrictEqual([{ packageName: "react-native-gesture-handler", line: 1 }]);
  });
});

describe("collectDeclaredDependencies", () => {
  it("reads every dependency field, because a test imports dev dependencies too", () => {
    const declared = collectDeclaredDependencies({
      dependencies: { effect: "catalog:" },
      devDependencies: { vitest: "^4" },
      peerDependencies: { react: "^19" },
      optionalDependencies: { fsevents: "^2" },
    });
    expect([...declared].toSorted()).toStrictEqual(["effect", "fsevents", "react", "vitest"]);
  });

  it("treats a manifest with no dependency fields as declaring nothing", () => {
    expect(collectDeclaredDependencies({ name: "ras-code" }).size).toBe(0);
  });
});

describe("findUndeclaredForkDependencies", () => {
  const declared = (names: ReadonlyArray<string>) => () => new Set(names);

  it("catches the dependency an upstream prune removed from under a fork-only file", () => {
    const found = findUndeclaredForkDependencies(
      [
        {
          path: "apps/server/src/cloud/RasRelayConnector.ts",
          contents: 'import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";\n',
        },
      ],
      declared(["@effect/platform-node"]),
    );
    expect(found).toStrictEqual([
      {
        path: "apps/server/src/cloud/RasRelayConnector.ts",
        line: 1,
        packageName: "@effect/platform-node-shared",
      },
    ]);
  });

  it("stays quiet while the manifest still declares the import", () => {
    const found = findUndeclaredForkDependencies(
      [
        {
          path: "apps/server/src/cloud/RasRelayConnector.ts",
          contents: 'import * as NodeSocket from "@effect/platform-node-shared/NodeSocket";\n',
        },
      ],
      declared(["@effect/platform-node-shared"]),
    );
    expect(found).toStrictEqual([]);
  });

  it("spares the rebrand fixtures, whose imports name upstream on purpose", () => {
    const found = findUndeclaredForkDependencies(
      [
        {
          path: "scripts/lib/upstreamRebrandMap.test.ts",
          contents: 'import x from "@t3tools/contracts";\n',
        },
      ],
      declared([]),
    );
    expect(found).toStrictEqual([]);
  });
});

describe("formatUndeclaredForkDependencies", () => {
  it("groups every importer under the package so one prune reads as one problem", () => {
    const message = formatUndeclaredForkDependencies([
      { path: "apps/server/src/a.ts", line: 1, packageName: "@effect/platform-node-shared" },
      { path: "apps/server/src/b.ts", line: 4, packageName: "@effect/platform-node-shared" },
    ]);
    expect(message).toContain(
      "  @effect/platform-node-shared — imported by apps/server/src/a.ts:1, apps/server/src/b.ts:4",
    );
  });

  it("says so plainly when nothing is undeclared", () => {
    expect(formatUndeclaredForkDependencies([])).toBe(
      "No fork-only file imports a package its manifest has stopped declaring.",
    );
  });
});
