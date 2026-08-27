# Customize a project icon

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
