import { describe, expect, it } from "@effect/vitest";
import {
  AssetPreviewTypeValidationError,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceAssetOutsideRootError,
  AssetWorkspacePathValidationError,
  EnvironmentId,
  ThreadId,
} from "@ras-code/contracts";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  assetUrlFailureLabel,
  assetUrlFailureReason,
  createAssetEnvironmentAtoms,
  InvalidAssetCollectionKeyError,
  parseAssetCollectionKey,
  resolveAssetUrl,
} from "./assets.ts";

describe("asset collection keys", () => {
  it("preserves malformed JSON and its native cause", () => {
    const key = "not-json";
    let error: unknown;

    try {
      parseAssetCollectionKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(InvalidAssetCollectionKeyError);
    expect(error).toMatchObject({ key, cause: expect.any(SyntaxError) });
  });

  it("rejects invalid asset collection shapes", () => {
    const key = JSON.stringify(["environment-1", [{ _tag: "unknown" }]]);

    expect(() => parseAssetCollectionKey(key)).toThrowError(InvalidAssetCollectionKeyError);
  });
});

describe("createAssetEnvironmentAtoms", () => {
  it("keys asset URL queries by environment and resource", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const assets = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const originalTarget = {
      environmentId,
      input: {
        resource: {
          _tag: "project-favicon" as const,
          cwd: "/repo/original",
        },
      },
    };

    expect(assets.createUrl(originalTarget)).toBe(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/original",
          },
        },
      }),
    );
    expect(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/next",
          },
        },
      }),
    ).not.toBe(assets.createUrl(originalTarget));
    expect(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/original",
            path: "brand/icon.svg",
          },
        },
      }),
    ).not.toBe(assets.createUrl(originalTarget));
    expect(
      assets.createUrl({
        environmentId: EnvironmentId.make("environment-2"),
        input: originalTarget.input,
      }),
    ).not.toBe(assets.createUrl(originalTarget));
  });

  it("keys collections while preserving independent resource queries", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const assets = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const resources = [
      { _tag: "attachment" as const, attachmentId: "attachment-1" },
      { _tag: "attachment" as const, attachmentId: "attachment-2" },
    ];

    expect(assets.createUrls({ environmentId, resources })).toBe(
      assets.createUrls({
        environmentId,
        resources: resources.map((resource) => ({ ...resource })),
      }),
    );
    expect(
      assets.createUrls({
        environmentId,
        resources: [...resources].toReversed(),
      }),
    ).not.toBe(assets.createUrls({ environmentId, resources }));
  });
});

describe("resolveAssetUrl", () => {
  it("preserves a managed endpoint gateway prefix for relative assets", () => {
    expect(
      resolveAssetUrl("https://gateway.example.com/e/abcdef0123456789/", "/api/assets/one"),
    ).toBe("https://gateway.example.com/e/abcdef0123456789/api/assets/one");
  });

  it("keeps absolute asset URLs unchanged", () => {
    expect(
      resolveAssetUrl("https://gateway.example.com/e/abcdef0123456789/", "https://cdn.test/one"),
    ).toBe("https://cdn.test/one");
  });
});

describe("asset failure reasons", () => {
  const resource = {
    _tag: "workspace-file",
    threadId: ThreadId.make("thread-1"),
    path: "/tmp/outside/shot.png",
  } as const;

  it.each([
    [new AssetWorkspaceAssetOutsideRootError({ resource }), "outside-project"],
    [new AssetWorkspacePathValidationError({ resource, cause: "outside" }), "outside-project"],
    [new AssetWorkspaceAssetNotFoundError({ resource }), "not-found"],
    [new AssetPreviewTypeValidationError({ resource }), "unsupported-type"],
    [new Error("socket closed"), "unavailable"],
  ])("maps %s to a reason a reader can act on", (error, expected) => {
    expect(assetUrlFailureReason(Cause.fail(error))).toBe(expected);
  });

  it("labels the reason without leaking the error tag", () => {
    expect(assetUrlFailureLabel("outside-project")).toBe("Image is outside the project folder");
    expect(assetUrlFailureLabel("not-found")).toBe("Image not found");
    expect(assetUrlFailureLabel("unsupported-type")).toBe("Unsupported image type");
    expect(assetUrlFailureLabel("unavailable")).toBe("Image unavailable");
  });
});
