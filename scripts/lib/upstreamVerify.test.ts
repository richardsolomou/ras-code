import { describe, expect, it } from "vite-plus/test";

import {
  findImportResidue,
  findPathResidue,
  formatResidue,
  isContentExempt,
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
