import type { ExpoConfig } from "expo/config";

import { clerkFrontendApiHostnameFromPublishableKey } from "@ras-code/shared/relayAuth";

import { BRAND_ASSET_PATHS } from "../../scripts/lib/brand-assets.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

type AppVariant = "development" | "preview" | "production";

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

const APP_VARIANT = resolveAppVariant(repoEnv.APP_VARIANT);
const isIosPersonalTeamBuild = repoEnv.RAS_CODE_IOS_PERSONAL_TEAM === "1";

const configuredClerkRelyingParties = (() => {
  const explicit = repoEnv.RAS_CODE_CLERK_PASSKEY_RP_DOMAINS?.trim();
  if (explicit) {
    return explicit
      .split(",")
      .map((domain) => domain.trim())
      .filter(Boolean);
  }
  const publishableKey = repoEnv.RAS_CODE_CLERK_PUBLISHABLE_KEY?.trim();
  return publishableKey ? [clerkFrontendApiHostnameFromPublishableKey(publishableKey)] : [];
})();

const personalTeamBundleIdentifier = repoEnv.RAS_CODE_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim();
const IOS_BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

const fromRepoRoot = (relativePath: string) => `../../${relativePath}`;
// Universal exports already contain their own rounded-square silhouette. Using one as an adaptive
// foreground makes Android draw an icon shape inside the launcher's mask.
const androidAdaptiveForeground = "./assets/android-icon-foreground.png";

if (
  isIosPersonalTeamBuild &&
  (!personalTeamBundleIdentifier ||
    !IOS_BUNDLE_IDENTIFIER_PATTERN.test(personalTeamBundleIdentifier))
) {
  throw new Error(
    "RAS_CODE_IOS_PERSONAL_TEAM_BUNDLE_ID must be a reverse-DNS identifier such as com.example.ras-code when RAS_CODE_IOS_PERSONAL_TEAM=1.",
  );
}

const DEVELOPMENT_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIosIconPng),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#00639B",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#00639B",
} as const;

const PREVIEW_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.nightlyIosIconPng),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#111533",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#7565C7",
} as const;

const RELEASE_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#000000",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#FFFFFF",
} as const;

const VARIANT_CONFIG = {
  development: {
    appName: "RAS Code Dev",
    scheme: "ras-code-dev",
    iosBundleIdentifier: "com.richardsolomou.ras-code.dev",
    androidPackage: "com.richardsolomou.ras_code.dev",
    assets: DEVELOPMENT_ASSETS,
  },
  preview: {
    appName: "RAS Code Preview",
    scheme: "ras-code-preview",
    iosBundleIdentifier: "com.richardsolomou.ras-code.preview",
    androidPackage: "com.richardsolomou.ras_code.preview",
    assets: PREVIEW_ASSETS,
  },
  production: {
    appName: "RAS Code",
    scheme: "ras-code",
    iosBundleIdentifier: "com.richardsolomou.ras-code",
    androidPackage: "com.richardsolomou.ras_code",
    assets: RELEASE_ASSETS,
  },
} as const;

function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    default:
      return "production";
  }
}

const variant = VARIANT_CONFIG[APP_VARIANT];
const iosBundleIdentifier = isIosPersonalTeamBuild
  ? personalTeamBundleIdentifier!
  : variant.iosBundleIdentifier;

const barlowFonts = {
  regular: "@expo-google-fonts/barlow/400Regular/Barlow_400Regular.ttf",
  medium: "@expo-google-fonts/barlow/500Medium/Barlow_500Medium.ttf",
  bold: "@expo-google-fonts/barlow/600SemiBold/Barlow_600SemiBold.ttf",
  legend:
    "@expo-google-fonts/barlow-semi-condensed/600SemiBold/BarlowSemiCondensed_600SemiBold.ttf",
} as const;

const widgetsPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-widgets",
  {
    bundleIdentifier: `${iosBundleIdentifier}.widgets`,
    groupIdentifier: `group.${iosBundleIdentifier}`,
    enablePushNotifications: true,
    // Agent activity can update many times an hour; without the
    // frequent-updates entitlement iOS throttles the update budget sooner.
    frequentUpdates: true,
    widgets: [
      {
        name: "AgentActivity",
        displayName: "Agent Activity",
        description: "Shows the current state of active RAS Code agents.",
        supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular"],
      },
    ],
  },
];

const sharingPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-sharing",
  {
    ios: {
      // Personal Teams cannot sign App Groups or extension targets. Keep the
      // reduced-capability local build usable while release builds expose the
      // real system share target.
      enabled: !isIosPersonalTeamBuild,
      extensionBundleIdentifier: `${iosBundleIdentifier}.sharing`,
      appGroupId: `group.${iosBundleIdentifier}`,
      activationRule: {
        supportsText: true,
        supportsWebUrlWithMaxCount: 1,
        supportsImageWithMaxCount: 8,
      },
    },
    android: {
      enabled: true,
      singleShareMimeTypes: ["text/plain", "image/*"],
      multipleShareMimeTypes: ["image/*"],
    },
  },
];

// These aliases match the fonts' PostScript names on iOS. Register the same
// names on Android so React Native and the native composer use one set of
// family names without waiting for runtime font loading.

const config: ExpoConfig = {
  name: variant.appName,
  slug: "ras-code",
  platforms: ["ios", "android"],
  scheme: variant.scheme,
  version: "1.0.4",
  runtimeVersion: {
    // Fingerprint (not appVersion) so an OTA only reaches binaries whose native
    // project — native deps, config plugins, AND patches/ — matches the update.
    // With appVersion, every 0.1.0 build shares a runtime version, so a JS update
    // could land on a binary missing the native changes it needs and crash.
    policy: process.env.MOBILE_VERSION_POLICY ?? "fingerprint",
  },
  orientation: "portrait",
  icon: variant.assets.appIcon,
  userInterfaceStyle: "automatic",
  updates: {
    enabled: true,
    url: "https://u.expo.dev/TODO_RAS_CODE_EAS_PROJECT_ID",
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
  },
  ios: {
    icon: variant.assets.iosIcon,
    supportsTablet: true,
    // Multitasking-capable iPad apps cannot rotate programmatically, so the
    // showcase capture build requires full screen (see infoPlist below).
    requireFullScreen: process.env.RAS_CODE_SHOWCASE_CAPTURE_BUILD === "1",
    bundleIdentifier: iosBundleIdentifier,
    // Pin code signing to the Apple developer team so non-interactive `expo run:ios`
    // does not fall back to a personal team (which cannot sign app groups,
    // Sign in with Apple, or push notification entitlements).
    appleTeamId: "TODO_RAS_CODE_APPLE_TEAM_ID",
    associatedDomains: configuredClerkRelyingParties.flatMap((domain) => [
      `applinks:${domain}`,
      `webcredentials:${domain}`,
    ]),
    infoPlist: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription:
        "Allow RAS Code to connect to RAS Code servers on your local network or tailnet.",
      ITSAppUsesNonExemptEncryption: false,
      // The App Store screenshot harness rotates the iPad interface from
      // inside the app (CI denies osascript the Accessibility access that
      // Simulator menu scripting needs), and iPadOS ignores programmatic
      // orientation requests for multitasking-capable apps — so the capture
      // build opts out of multitasking and declares landscape support.
      ...(process.env.RAS_CODE_SHOWCASE_CAPTURE_BUILD === "1"
        ? {
            "UISupportedInterfaceOrientations~ipad": [
              "UIInterfaceOrientationPortrait",
              "UIInterfaceOrientationPortraitUpsideDown",
              "UIInterfaceOrientationLandscapeLeft",
              "UIInterfaceOrientationLandscapeRight",
            ],
          }
        : {}),
    },
  },
  android: {
    icon: variant.assets.appIcon,
    package: variant.androidPackage,
    adaptiveIcon: {
      backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
      foregroundImage: variant.assets.androidAdaptiveForeground,
      monochromeImage: variant.assets.androidMonochromeIcon,
    },
    // Opts into OnBackInvokedCallback-based back dispatch (Android 13+).
    // JS back handling survives it via react-native's Android 16 shim plus
    // withAndroidPredictiveBackCompat on Android 13-15.
    predictiveBackGestureEnabled: true,
  },
  web: {
    favicon: variant.assets.appIcon,
  },
  plugins: [
    "expo-asset",
    [
      "expo-font",
      {
        ios: {
          fonts: [barlowFonts.regular, barlowFonts.medium, barlowFonts.bold, barlowFonts.legend],
        },
        android: {
          fonts: [
            {
              fontFamily: "Barlow-Regular",
              fontDefinitions: [{ path: barlowFonts.regular, weight: 400 }],
            },
            {
              fontFamily: "Barlow-Medium",
              fontDefinitions: [{ path: barlowFonts.medium, weight: 500 }],
            },
            {
              fontFamily: "Barlow-SemiBold",
              fontDefinitions: [{ path: barlowFonts.bold, weight: 600 }],
            },
            {
              fontFamily: "BarlowSemiCondensed-SemiBold",
              fontDefinitions: [{ path: barlowFonts.legend, weight: 600 }],
            },
          ],
        },
      },
    ],
    "expo-secure-store",
    "expo-sqlite",
    ...(isIosPersonalTeamBuild
      ? [sharingPlugin]
      : ["./plugins/withShareExtensionDisplayName.cjs", sharingPlugin]),
    [
      "expo-notifications",
      {
        icon: variant.assets.androidNotificationIcon,
        color: variant.assets.androidNotificationColor,
        mode: APP_VARIANT === "development" ? "development" : "production",
      },
    ],
    // appleSignIn must be gated here: withoutIosPersonalTeamCapabilities.cjs runs before
    // plugins earlier in this array, so it cannot strip the entitlement Clerk would add.
    ["@clerk/expo", { theme: "./clerk-theme.json", appleSignIn: !isIosPersonalTeamBuild }],
    "expo-web-browser",
    [
      "expo-quick-actions",
      {
        // Adaptive launcher-shortcut icon; referenced by resource name from
        // the shortcut items set in src/features/shortcuts.
        androidIcons: {
          shortcut_icon: {
            foregroundImage: variant.assets.androidAdaptiveForeground,
            backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
          },
        },
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: "Allow RAS Code to access your camera so you can scan pairing QR codes.",
        microphonePermission: false,
        barcodeScannerEnabled: true,
        recordAudioAndroid: false,
      },
    ],
    ["expo-image-picker", { photosPermission: false, microphonePermission: false }],
    [
      "expo-splash-screen",
      {
        image: variant.assets.splashIcon,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        imageWidth: 220,
        dark: {
          image: variant.assets.splashIcon,
          backgroundColor: "#0a0a0a",
        },
      },
    ],
    [
      "expo-build-properties",
      {
        ios: {
          deploymentTarget: "18.0",
          // AppCheckCore 11.3+ includes Swift and needs module maps for these Objective-C dependencies.
          extraPods: [
            { name: "GoogleUtilities", modular_headers: true },
            { name: "RecaptchaInterop", modular_headers: true },
          ],
        },
      },
    ],
    "./plugins/withIosCocoaPodsUuidCache.cjs",
    // Must be listed BEFORE expo-widgets: same-type mods run last-registered-
    // first, so registering earlier makes this plugin's mods run AFTER
    // expo-widgets' — its dangerous mod wipes ios/ExpoWidgetsTarget/ (which
    // would delete the asset catalog) and its xcodeproj mod creates the widget
    // target (which must exist before the compile phase can be attached).
    ...(!isIosPersonalTeamBuild ? ["./plugins/withWidgetLogoAsset.cjs", widgetsPlugin] : []),
    "./plugins/withIosSceneLifecycle.cjs",
    "./plugins/withAndroidCleartextTraffic.cjs",
    "./plugins/withAndroidGradleHeap.cjs",
    "./plugins/withAndroidModernPopupMenu.cjs",
    "./plugins/withAndroidModernAlertDialog.cjs",
    "./plugins/withAndroidPredictiveBackCompat.cjs",
    "./plugins/withAndroidTabletOrientation.cjs",
    ...(isIosPersonalTeamBuild ? ["./plugins/withoutIosPersonalTeamCapabilities.cjs"] : []),
  ],
  extra: {
    appVariant: APP_VARIANT,
    iosPersonalTeamBuild: isIosPersonalTeamBuild,
    relay: {
      url: repoEnv.RAS_CODE_RELAY_URL ?? null,
    },
    clerk: {
      publishableKey: repoEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
      jwtTemplate: repoEnv.EXPO_PUBLIC_CLERK_JWT_TEMPLATE ?? null,
    },
    // Native Google sign-in credentials. @clerk/expo reads these from `extra`
    // under their exact env-var names (not nested), and its config plugin reads
    // the iOS URL scheme at prebuild to register it in Info.plist.
    // Unset values must be omitted (not null): the public manifest serializes
    // null to {}, which is truthy and would defeat Clerk's fallback checks.
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME,
    observability: {
      tracesUrl: repoEnv.EXPO_PUBLIC_OTLP_TRACES_URL ?? "https://api.axiom.co/v1/traces",
      tracesDataset: repoEnv.EXPO_PUBLIC_OTLP_TRACES_DATASET ?? null,
      tracesToken: repoEnv.EXPO_PUBLIC_OTLP_TRACES_TOKEN ?? null,
    },
    eas: {
      projectId: "TODO_RAS_CODE_EAS_PROJECT_ID",
    },
  },
  owner: "TODO_RAS_CODE_EAS_OWNER",
};

export default config;
