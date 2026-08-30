#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import {
  composeIconSvg,
  encodePngIco,
  type IconArtwork,
  type IconShape,
  parseIconFill,
  renderIconPng,
  WINDOWS_ICON_SIZES,
} from "./lib/icon-export.ts";

const IconComposerProject = Schema.Struct({
  fill: Schema.Struct({ solid: Schema.NonEmptyString }),
  groups: Schema.Array(
    Schema.Struct({
      layers: Schema.Array(Schema.Struct({ "image-name": Schema.NonEmptyString })),
    }),
  ),
});
const decodeIconComposerProject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(IconComposerProject),
);

interface VariantOutputs {
  readonly ios: string;
  readonly macos: string;
  readonly universal: string;
  readonly appleTouch: string;
  readonly favicon16: string;
  readonly favicon32: string;
  readonly faviconIco: string;
  readonly windowsIco: string;
}

interface IconVariant {
  readonly label: string;
  readonly source: string;
  readonly outputs: VariantOutputs;
}

export class IconExportFileSystemError extends Schema.TaggedErrorClass<IconExportFileSystemError>()(
  "IconExportFileSystemError",
  {
    operation: Schema.Literals([
      "resolve-repository-root",
      "check-path",
      "read-file",
      "make-directory",
      "make-temp-file",
      "write-file",
      "rename-file",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Icon export file-system operation '${this.operation}' failed for ${this.path}.`;
  }
}

export class IconExportProjectError extends Schema.TaggedErrorClass<IconExportProjectError>()(
  "IconExportProjectError",
  {
    sourcePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not read the Icon Composer project at ${this.sourcePath}.`;
  }
}

export class IconExportSourceMissingError extends Schema.TaggedErrorClass<IconExportSourceMissingError>()(
  "IconExportSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing Icon Composer source project: ${this.sourcePath}`;
  }
}

export class IconExportRenderError extends Schema.TaggedErrorClass<IconExportRenderError>()(
  "IconExportRenderError",
  {
    variant: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to render the ${this.variant} icon.`;
  }
}

export class IconExportAssetsStaleError extends Schema.TaggedErrorClass<IconExportAssetsStaleError>()(
  "IconExportAssetsStaleError",
  {
    paths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Generated icon assets are stale:\n${this.paths.map((path) => `- ${path}`).join("\n")}`;
  }
}

const ICON_VARIANTS = [
  {
    label: "development",
    source: BRAND_ASSET_PATHS.developmentIconComposerProject,
    outputs: {
      ios: BRAND_ASSET_PATHS.developmentIosIconPng,
      macos: BRAND_ASSET_PATHS.developmentDesktopIconPng,
      universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
      appleTouch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    },
  },
  {
    label: "preview",
    source: BRAND_ASSET_PATHS.canaryIconComposerProject,
    outputs: {
      ios: BRAND_ASSET_PATHS.canaryIosIconPng,
      macos: BRAND_ASSET_PATHS.canaryMacIconPng,
      universal: BRAND_ASSET_PATHS.canaryLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.canaryWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.canaryWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.canaryWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.canaryWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.canaryWindowsIconIco,
    },
  },
  {
    label: "production",
    source: BRAND_ASSET_PATHS.productionIconComposerProject,
    outputs: {
      ios: BRAND_ASSET_PATHS.productionIosIconPng,
      macos: BRAND_ASSET_PATHS.productionMacIconPng,
      universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    },
  },
] as const satisfies ReadonlyArray<IconVariant>;

const RepositoryRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
  Effect.mapError(
    (cause) =>
      new IconExportFileSystemError({
        operation: "resolve-repository-root",
        path: new URL("..", import.meta.url).pathname,
        cause,
      }),
  ),
);

const readIconArtwork = Effect.fn("iconExport.readIconArtwork")(function* (projectPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(projectPath, "icon.json");
  const manifest = yield* fs
    .readFileString(manifestPath)
    .pipe(
      Effect.mapError(
        (cause) =>
          new IconExportFileSystemError({ operation: "read-file", path: manifestPath, cause }),
      ),
    );
  const project = yield* decodeIconComposerProject(manifest).pipe(
    Effect.mapError((cause) => new IconExportProjectError({ sourcePath: projectPath, cause })),
  );
  const background = yield* Effect.try({
    try: () => parseIconFill(project.fill.solid),
    catch: (cause) => new IconExportProjectError({ sourcePath: projectPath, cause }),
  });
  const layerNames = project.groups.flatMap((group) =>
    group.layers.map((layer) => layer["image-name"]),
  );
  const layers = yield* Effect.forEach(layerNames, (name) => {
    const layerPath = path.join(projectPath, "Assets", name);
    return fs
      .readFileString(layerPath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new IconExportFileSystemError({ operation: "read-file", path: layerPath, cause }),
        ),
      );
  });

  return { background, layers } satisfies IconArtwork;
});

const renderVariant = Effect.fn("iconExport.renderVariant")(function* (
  repositoryRoot: string,
  variant: IconVariant,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(repositoryRoot, variant.source);
  const sourceExists = yield* fs.exists(sourcePath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "check-path",
          path: sourcePath,
          cause,
        }),
    ),
  );
  if (!sourceExists) {
    return yield* new IconExportSourceMissingError({ sourcePath: variant.source });
  }

  const artwork = yield* readIconArtwork(sourcePath);
  const documents = {
    "full-bleed": composeIconSvg(artwork, "full-bleed"),
    macos: composeIconSvg(artwork, "macos"),
  } satisfies Record<IconShape, string>;
  const render = (shape: IconShape, size: number) =>
    Effect.try({
      try: () => renderIconPng(documents[shape], size, { opaque: shape === "full-bleed" }),
      catch: (cause) => new IconExportRenderError({ variant: variant.label, cause }),
    });

  const fullBleed = yield* render("full-bleed", 1024);
  const icoRenditions = yield* Effect.forEach(WINDOWS_ICON_SIZES, (size) =>
    render("full-bleed", size).pipe(Effect.map((contents) => ({ size, contents }))),
  );
  const ico = yield* Effect.try({
    try: () => encodePngIco(icoRenditions),
    catch: (cause) => new IconExportRenderError({ variant: variant.label, cause }),
  });

  return new Map<string, Buffer>([
    [variant.outputs.ios, fullBleed],
    [variant.outputs.universal, fullBleed],
    [variant.outputs.macos, yield* render("macos", 1024)],
    [variant.outputs.appleTouch, yield* render("full-bleed", 180)],
    [variant.outputs.favicon16, yield* render("full-bleed", 16)],
    [variant.outputs.favicon32, yield* render("full-bleed", 32)],
    [variant.outputs.faviconIco, ico],
    [variant.outputs.windowsIco, ico],
  ]);
});

const writeAtomically = Effect.fn("iconExport.writeAtomically")(function* (
  repositoryRoot: string,
  relativePath: string,
  contents: Buffer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetPath = path.join(repositoryRoot, relativePath);
  const targetDirectory = path.dirname(targetPath);
  yield* fs.makeDirectory(targetDirectory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "make-directory",
          path: targetDirectory,
          cause,
        }),
    ),
  );
  const temporaryPath = yield* fs
    .makeTempFileScoped({
      directory: targetDirectory,
      prefix: ".ras-code-icon-export-",
      suffix: ".tmp",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new IconExportFileSystemError({
            operation: "make-temp-file",
            path: targetDirectory,
            cause,
          }),
      ),
    );
  yield* fs.writeFile(temporaryPath, contents).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "write-file",
          path: temporaryPath,
          cause,
        }),
    ),
  );
  yield* fs.rename(temporaryPath, targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "rename-file",
          path: targetPath,
          cause,
        }),
    ),
  );
});

const isCurrent = Effect.fn("iconExport.isCurrent")(function* (
  repositoryRoot: string,
  relativePath: string,
  expected: Buffer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetPath = path.join(repositoryRoot, relativePath);
  const exists = yield* fs.exists(targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "check-path",
          path: targetPath,
          cause,
        }),
    ),
  );
  if (!exists) return false;

  const actual = yield* fs.readFile(targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "read-file",
          path: targetPath,
          cause,
        }),
    ),
  );
  return Buffer.from(actual).equals(expected);
});

export const exportBrandIcons = Effect.fn("exportBrandIcons")(function* (checkOnly: boolean) {
  const repositoryRoot = yield* RepositoryRoot;

  const generated = new Map<string, Buffer>();
  for (const variant of ICON_VARIANTS) {
    yield* Console.log(`Rendering ${variant.label} from ${variant.source}...`);
    const variantAssets = yield* renderVariant(repositoryRoot, variant);
    for (const [relativePath, contents] of variantAssets) {
      generated.set(relativePath, contents);
    }
  }

  for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    const sourceContents = generated.get(override.sourceRelativePath);
    if (sourceContents === undefined) {
      return yield* Effect.die(
        new Error(`Generated development web icon is missing: ${override.sourceRelativePath}`),
      );
    }
    generated.set(override.targetRelativePath, sourceContents);
  }

  if (checkOnly) {
    const stale = yield* Effect.filter(
      [...generated.entries()],
      ([relativePath, contents]) =>
        isCurrent(repositoryRoot, relativePath, contents).pipe(Effect.map((current) => !current)),
      { concurrency: "unbounded" },
    );
    if (stale.length > 0) {
      return yield* new IconExportAssetsStaleError({
        paths: stale.map(([relativePath]) => relativePath),
      });
    }
    yield* Console.log(`All ${generated.size} generated icon assets are current.`);
    return;
  }

  yield* Effect.forEach(
    generated,
    ([relativePath, contents]) => writeAtomically(repositoryRoot, relativePath, contents),
    { concurrency: 1, discard: true },
  );
  yield* Console.log(`Updated ${generated.size} generated icon assets.`);
});

export const exportBrandIconsCommand = Command.make(
  "export-brand-icons",
  {
    check: Flag.boolean("check").pipe(
      Flag.withDescription("Verify generated icon assets without modifying files."),
      Flag.withDefault(false),
    ),
  },
  ({ check }) => exportBrandIcons(check).pipe(Effect.scoped),
).pipe(
  Command.withDescription("Render development, preview, and production assets from the icon art."),
);

if (import.meta.main) {
  Command.run(exportBrandIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
