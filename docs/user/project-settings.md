# Project settings

## Customize a project icon

RAS Code selects a project icon automatically. It checks `ras.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

RAS Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

## Use an emoji

To show an emoji instead of an icon file:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. In the **Emoji** box, type or paste one emoji.

The emoji replaces the icon file everywhere the project appears. Clear the box to show the icon
file again.

A project can also declare its emoji in `ras.json`:

```json
{ "iconEmoji": "🚀" }
```

RAS Code uses the `ras.json` emoji when the project has no emoji set in **Settings**.

## Choose the model for new threads

New threads start on the model that RAS Code resolves in this order:

1. The model selected in the thread itself.
2. The project's default model.
3. The default model in **Settings → General → Default model**.
4. The provider's own default model.

To set the default model for every project, open **Settings**, select **General**, and select a
model in **Default model**. Select **Reset** to use the provider's default model again.

To give one project a different model, open **Settings**, select **Projects**, select the project,
and select a model under **New threads**. The project setting applies to each checkout in the
project group and replaces the default model for that project. Select **Reset** to make the project
follow the default model again.

From a terminal, `ras project model <project> --inherit` clears a project's own default, and `ras project model <project> --model <id> --provider <instance>` sets one. `<project>` is the project id or its workspace root.

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

RAS Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
