import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeURL from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: [
      "**/.repos/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    setupFiles: [
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/longTempDir.ts", import.meta.url),
      ),
    ],
  },
  staged: {
    // Formatter only for now — no lint or typecheck on commit.
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns: [
      ".reference",
      ".repos/**",
      ".alchemy",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/web/src/lib/vendor/qrcodegen.ts",
      "apps/mobile/uniwind-types.d.ts",
      "*.icon/**",
    ],
    sortPackageJson: {},
    overrides: [
      {
        files: [".devcontainer/devcontainer.json"],
        options: {
          trailingComma: "none",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-ras-code/index.ts"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@t3tools/client-runtime",
              message:
                "Import from an explicit @t3tools/client-runtime/* subpath. The package has no root export.",
            },
            {
              name: "@pierre/diffs/react",
              importNames: ["CodeView"],
              message:
                "Use StyledDiffCodeView so web diff surfaces share styling and virtualized geometry.",
            },
          ],
        },
      ],
      "ras-code/no-global-process-runtime": "error",
      "ras-code/no-inline-schema-compile": "warn",
      "ras-code/no-manual-effect-runtime-in-tests": "error",
      "ras-code/no-native-title-tooltip": "error",
      "ras-code/namespace-node-imports": "error",
    },
    overrides: [
      {
        files: ["apps/web/src/**", "apps/mobile/src/**", "apps/desktop/src/**"],
        rules: { "react/rules-of-hooks": "error" },
      },
      {
        files: ["packages/shared/src/hostProcess.ts"],
        rules: { "ras-code/no-global-process-runtime": "off" },
      },
      ...Object.entries({
        "apps/server/src/orchestration/Layers/CheckpointReactor.test.ts": 42,
        "apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts": 5,
        "apps/server/src/orchestration/Layers/OrchestrationReactor.test.ts": 4,
        "apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts": 18,
        "apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts": 28,
        "apps/server/src/orchestration/Layers/ThreadDeletionReactor.test.ts": 2,
        "apps/server/src/orchestration/commandInvariants.test.ts": 5,
        "apps/server/src/orchestration/projector.test.ts": 20,
        "apps/server/src/provider/Layers/CodexAdapter.test.ts": 1,
        "apps/server/src/provider/Layers/CodexSessionRuntime.test.ts": 5,
        "apps/server/src/provider/Layers/CursorAdapter.test.ts": 1,
        "apps/server/src/provider/Layers/CursorProvider.test.ts": 1,
        "apps/server/src/provider/Layers/ProviderService.test.ts": 2,
        "apps/server/src/provider/Layers/ProviderSessionReaper.test.ts": 12,
        "apps/server/src/provider/acp/CursorAcpSupport.test.ts": 1,
        "apps/server/src/relay/AgentAwarenessRelay.test.ts": 1,
        "oxlint-plugin-ras-code/rules/no-manual-effect-runtime-in-tests.test.ts": 8,
      }).map(([file, maxOccurrences]) => {
        const rule: ["error", { maxOccurrences: number }] = ["error", { maxOccurrences }];
        return { files: [file], rules: { "ras-code/no-manual-effect-runtime-in-tests": rule } };
      }),
    ],
    options: {
      reportUnusedDisableDirectives: "error",
      // Revisit once Oxlint's tsgolint path can integrate with @effect/tsgo diagnostics.
      typeAware: false,
      typeCheck: false,
    },
  },
});
