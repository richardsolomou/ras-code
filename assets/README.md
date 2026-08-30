# Brand icons

The three Icon Composer projects are the source of truth for full application icons:

- `dev/app-icon.icon`
- `canary/app-icon.icon`
- `prod/app-icon.icon`

Each project uses `text.svg` for the activity-field R mark. Additional layers use semantic names that describe their role and placement.

Run `vp run icons:export` from the repository root to regenerate the tracked iOS, macOS, Linux,
Windows, and web assets. The development web exports are also copied to `apps/web/public` for the
browser favicon and splash screen. Run `vp run icons:check` to verify that the generated assets and
public copies match their sources without changing files.

The exporter runs on any platform. It reads each project's background fill and layer SVGs and
rasterises them itself, so no Icon Composer install, no Xcode, and no macOS host is involved. Icon
Composer still opens the projects for authoring; only two fields drive the output, `fill.solid` and
each layer's `image-name`.

## What the exporter draws

- **Full bleed** for iOS, Linux, Windows, and the web: the background fill across the whole canvas
  with the layers over it. Every platform applies its own mask. These renditions are written without
  an alpha channel, because the App Store rejects an iOS app icon that carries one.
- **macOS**: the classic safe area, an 824x824 body inset 100px on a 1024x1024 canvas with a 185px
  corner radius, and transparency outside it.

Do not edit the generated PNG or ICO files directly.

## Android adaptive foreground

`apps/mobile/assets/android-icon-foreground.svg` is the source of truth for the foreground used by
the normal Android adaptive launcher icon. Export its paired PNG after changing it:

```sh
rsvg-convert -w 432 -h 432 \
  -o apps/mobile/assets/android-icon-foreground.png \
  apps/mobile/assets/android-icon-foreground.svg
rsvg-convert -w 432 -h 432 \
  -o apps/mobile/assets/android-icon-mark.png \
  apps/mobile/assets/android-icon-mark.svg
rsvg-convert -w 96 -h 96 \
  -o apps/mobile/assets/android-notification-icon.png \
  apps/mobile/assets/android-icon-mark.svg
```

The foreground must remain transparent and keep the activity field inside Android's adaptive-icon safe zone. `android-icon-mark.svg` is the source for Android's monochrome themed icon and notification mark.
