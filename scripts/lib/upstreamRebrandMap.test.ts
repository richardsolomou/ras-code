import { assert, describe, it } from "@effect/vitest";

import {
  findResidualBrandTokens,
  mapPatchPaths,
  mapUpstreamPath,
  rebrandPatch,
  rebrandText,
} from "./upstreamRebrandMap.ts";

describe("rebrandText", () => {
  it("rewrites the workspace package scope", () => {
    assert.strictEqual(
      rebrandText('import { Foo } from "@t3tools/contracts";'),
      'import { Foo } from "@ras-code/contracts";',
    );
  });

  it("rewrites product-scoped environment variables", () => {
    assert.strictEqual(rebrandText("process.env.T3CODE_HOME"), "process.env.RAS_CODE_HOME");
  });

  it("keeps the session cookie name off the ras_code_ prefix", () => {
    assert.strictEqual(rebrandText('cookie: "t3_session_5775"'), 'cookie: "ras_session_5775"');
  });

  it("rewrites remaining screaming-snake identifiers to the RAS_ prefix", () => {
    assert.strictEqual(rebrandText("T3_ACP_EMIT_TOOL_CALLS"), "RAS_ACP_EMIT_TOOL_CALLS");
  });

  it("widens the identifiers we moved under RAS_CODE_", () => {
    assert.strictEqual(rebrandText("T3_BOOT_SERVICE_UNIT"), "RAS_CODE_BOOT_SERVICE_UNIT");
  });

  it("rewrites the default theme constants", () => {
    assert.strictEqual(rebrandText("T3_CHAT_THEME_ID"), "RAS_CODE_THEME_ID");
  });

  it("rewrites a product-scoped identifier namespace", () => {
    assert.strictEqual(
      rebrandText('Symbol.for("t3.mobile.hot-atom-runtimes")'),
      'Symbol.for("ras-code.mobile.hot-atom-runtimes")',
    );
    assert.strictEqual(
      rebrandText('>()("t3/provider/OpenCodeServerOwner") {}'),
      '>()("ras-code/provider/OpenCodeServerOwner") {}',
    );
  });

  it("leaves upstream hosts and AWS instance types spelled t3 alone", () => {
    assert.strictEqual(rebrandText('url: "t3.chat"'), 'url: "t3.chat"');
    assert.strictEqual(rebrandText('instanceType: "t3.micro"'), 'instanceType: "t3.micro"');
  });

  it("rewrites the product name", () => {
    assert.strictEqual(rebrandText("Welcome to T3 Code."), "Welcome to RAS Code.");
  });

  it("rewrites the remote access product name", () => {
    assert.strictEqual(rebrandText("Connect through T3 Connect."), "Connect through RAS Connect.");
  });

  it("keeps upstream repository slugs and forks of them", () => {
    assert.strictEqual(
      rebrandText('url: "https://github.com/binbandit/t3code/pull/642"'),
      'url: "https://github.com/binbandit/t3code/pull/642"',
    );
    assert.strictEqual(rebrandText('repo: "PingDotGG/T3Code"'), 'repo: "PingDotGG/T3Code"');
    assert.strictEqual(rebrandText('repo: "t3tools/t3code"'), 'repo: "richardsolomou/ras-code"');
    assert.strictEqual(rebrandText('repo: "T3Tools/T3Code"'), 'repo: "richardsolomou/ras-code"');
  });

  it("keeps the WSL runtime cache paths that already exist on disk", () => {
    assert.strictEqual(
      rebrandText('runtime_parent="$HOME/.t3/wsl-runtime"'),
      'runtime_parent="$HOME/.t3/wsl-runtime"',
    );
    assert.strictEqual(rebrandText('".t3code-wsl-runtime-ready"'), '".t3code-wsl-runtime-ready"');
  });

  it("rewrites the PascalCase product name without doubling Code", () => {
    assert.strictEqual(rebrandText("ios/T3Code"), "ios/RasCode");
  });

  it("rewrites the remote access product name in ids and search terms", () => {
    assert.strictEqual(rebrandText('id: "t3-connect"'), 'id: "ras-connect"');
    assert.strictEqual(rebrandText('"tunnel saved t3 connect"'), '"tunnel saved ras connect"');
  });

  it("keeps project file types on the Ras prefix", () => {
    assert.strictEqual(rebrandText("T3ProjectFileLoader"), "RasProjectFileLoader");
  });

  it("rewrites other PascalCase identifiers to RasCode", () => {
    assert.strictEqual(rebrandText("RemoteT3RunnerOptions"), "RemoteRasCodeRunnerOptions");
  });

  it("rewrites camelCase identifiers", () => {
    assert.strictEqual(rebrandText("const t3Home = resolve()"), "const rasCodeHome = resolve()");
  });

  it("rewrites the project file name", () => {
    assert.strictEqual(rebrandText("Read t3.json first"), "Read ras.json first");
  });

  it("rewrites the home directory", () => {
    assert.strictEqual(rebrandText("copy from ~/.t3/userdata"), "copy from ~/.ras-code/userdata");
  });

  it("rewrites CSS custom properties", () => {
    assert.strictEqual(rebrandText("var(--t3-primary)"), "var(--ras-code-primary)");
  });

  it("rewrites mobile native module directories", () => {
    assert.strictEqual(rebrandText("modules/t3-terminal"), "modules/ras-code-terminal");
  });
});

describe("rebrandText do-not-rename list", () => {
  it("keeps the environment discovery path", () => {
    const source = 'const path = "/.well-known/t3/environment";';
    assert.strictEqual(rebrandText(source), source);
  });

  it("keeps the checkpoint ref namespace", () => {
    const source = 'const ref = "refs/t3/checkpoints/abc";';
    assert.strictEqual(rebrandText(source), source);
  });

  it("keeps the upstream hosts", () => {
    const source = 'const origins = ["app.t3.codes", "clerk.t3.codes"];';
    assert.strictEqual(rebrandText(source), source);
  });

  it("keeps the legacy theme ids", () => {
    const source = 'const legacy = ["t3-chat", "t3-chat-dark"];';
    assert.strictEqual(rebrandText(source), source);
  });

  it("keeps upstream repository references", () => {
    const source = "https://github.com/pingdotgg/t3code/pull/8235";
    assert.strictEqual(rebrandText(source), source);
  });

  it("does not double the Code in camelCase identifiers", () => {
    assert.strictEqual(
      rebrandText("t3CodeVersion, t3Code, t3Config"),
      "rasCodeVersion, rasCode, rasCodeConfig",
    );
  });

  it("keeps the relay provider kind wire value", () => {
    const source = 'providerKind: "t3_relay",';
    assert.strictEqual(rebrandText(source), source);
  });
});

describe("mapUpstreamPath", () => {
  it("leaves paths we never renamed alone", () => {
    assert.strictEqual(
      mapUpstreamPath("apps/server/src/orchestration/decider.ts"),
      "apps/server/src/orchestration/decider.ts",
    );
  });

  it("maps mobile native module directories", () => {
    assert.strictEqual(
      mapUpstreamPath("apps/mobile/modules/t3-terminal/ios/T3TerminalModule.swift"),
      "apps/mobile/modules/ras-code-terminal/ios/RasCodeTerminalModule.swift",
    );
  });

  it("maps the Android package directories", () => {
    assert.strictEqual(
      mapUpstreamPath(
        "apps/mobile/modules/t3-review-diff/android/src/main/java/expo/modules/t3reviewdiff/T3ReviewDiffView.kt",
      ),
      "apps/mobile/modules/ras-code-review-diff/android/src/main/java/expo/modules/ras_code/reviewdiff/RasCodeReviewDiffView.kt",
    );
  });

  it("maps the project file loader", () => {
    assert.strictEqual(
      mapUpstreamPath("apps/server/src/project/T3ProjectFileLoader.ts"),
      "apps/server/src/project/RasProjectFileLoader.ts",
    );
  });

  it("maps the contracts project file module", () => {
    assert.strictEqual(
      mapUpstreamPath("packages/contracts/src/t3ProjectFile.ts"),
      "packages/contracts/src/rasProjectFile.ts",
    );
  });

  it("maps the project file itself", () => {
    assert.strictEqual(mapUpstreamPath("t3.json"), "ras.json");
  });

  it("maps the oxlint plugin directory", () => {
    assert.strictEqual(
      mapUpstreamPath("oxlint-plugin-t3code/src/index.ts"),
      "oxlint-plugin-ras-code/src/index.ts",
    );
  });

  it("maps the agent skill directories", () => {
    assert.strictEqual(
      mapUpstreamPath(".agents/skills/test-t3-app/SKILL.md"),
      ".agents/skills/test-ras-app/SKILL.md",
    );
  });

  it("maps the RAS Connect internals doc", () => {
    assert.strictEqual(
      mapUpstreamPath("docs/internals/t3-connect.md"),
      "docs/internals/ras-connect.md",
    );
  });
});

describe("mapPatchPaths", () => {
  it("rewrites the diff headers and leaves the body alone", () => {
    const patch = [
      "diff --git a/t3.json b/t3.json",
      "index 1111111..2222222 100644",
      "--- a/t3.json",
      "+++ b/t3.json",
      "@@ -1,1 +1,1 @@",
      '-{ "name": "t3" }',
      '+{ "name": "t3-next" }',
      "",
    ].join("\n");

    assert.strictEqual(
      mapPatchPaths(patch),
      [
        "diff --git a/ras.json b/ras.json",
        "index 1111111..2222222 100644",
        "--- a/ras.json",
        "+++ b/ras.json",
        "@@ -1,1 +1,1 @@",
        '-{ "name": "t3" }',
        '+{ "name": "t3-next" }',
        "",
      ].join("\n"),
    );
  });
});

describe("rebrandPatch", () => {
  it("rebrands context and change lines but not hunk headers or blob ids", () => {
    const patch = [
      "diff --git a/apps/web/src/x.ts b/apps/web/src/x.ts",
      "index abct3111..def22222 100644",
      "--- a/apps/web/src/x.ts",
      "+++ b/apps/web/src/x.ts",
      "@@ -1,3 +1,3 @@ export const T3Thing = 1",
      ' import "@t3tools/shared";',
      "-const home = T3CODE_HOME;",
      "+const home = T3CODE_HOME ?? fallback;",
      "",
    ].join("\n");

    const lines = rebrandPatch(patch).split("\n");
    assert.strictEqual(lines[1], "index abct3111..def22222 100644");
    assert.strictEqual(lines[4], "@@ -1,3 +1,3 @@ export const T3Thing = 1");
    assert.strictEqual(lines[5], ' import "@ras-code/shared";');
    assert.strictEqual(lines[6], "-const home = RAS_CODE_HOME;");
    assert.strictEqual(lines[7], "+const home = RAS_CODE_HOME ?? fallback;");
  });
});

describe("findResidualBrandTokens", () => {
  it("reports brand tokens the table left behind", () => {
    assert.deepStrictEqual(findResidualBrandTokens("const label = T3 rules;"), [
      { line: 1, token: "T3" },
    ]);
  });

  it("ignores preserved spans", () => {
    assert.deepStrictEqual(findResidualBrandTokens('open("app.t3.codes")'), []);
  });

  it("does not mistake typed-array reads for brand tokens", () => {
    assert.deepStrictEqual(findResidualBrandTokens("view.getUint32(0)"), []);
  });
});
