import { SymbolView } from "./AppSymbol";
import { Image } from "expo-image";
import { useLayoutEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { EnvironmentId } from "@ras-code/contracts";
import {
  getProjectFaviconCacheKey,
  isProjectFaviconFallbackUrl,
} from "@ras-code/shared/projectFavicon";
import { useThemeColor } from "../lib/useThemeColor";
import { useAssetUrl } from "../state/assets";
import {
  beginProjectFaviconRequest,
  createProjectFaviconRequest,
  hasLoadedProjectFavicon,
  markProjectFaviconFailed,
  markProjectFaviconLoaded,
} from "./projectFaviconCache";

/* ─── Component ──────────────────────────────────────────────────────── */
export function ProjectFavicon(props: {
  readonly environmentId: EnvironmentId;
  readonly open?: boolean;
  readonly size?: number;
  readonly projectTitle: string;
  readonly workspaceRoot?: string | null;
  readonly faviconPath?: string | null;
  readonly iconEmoji?: string | null;
}) {
  const size = props.size ?? 42;
  const faviconUrl = useAssetUrl(
    props.environmentId,
    props.iconEmoji || props.workspaceRoot === null || props.workspaceRoot === undefined
      ? null
      : {
          _tag: "project-favicon",
          cwd: props.workspaceRoot,
          ...(props.faviconPath ? { path: props.faviconPath } : {}),
        },
  );
  if (props.iconEmoji) {
    return (
      <View
        style={{
          width: size,
          height: size,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          accessibilityRole="image"
          accessibilityLabel={`${props.projectTitle} icon`}
          style={{ fontSize: size * 0.64, lineHeight: size * 0.8 }}
        >
          {props.iconEmoji}
        </Text>
      </View>
    );
  }

  const renderableFaviconUrl = isProjectFaviconFallbackUrl(faviconUrl) ? null : faviconUrl;
  const cacheKey =
    renderableFaviconUrl && props.workspaceRoot
      ? getProjectFaviconCacheKey(props.environmentId, props.workspaceRoot, renderableFaviconUrl)
      : null;

  return (
    <ProjectFaviconImage
      key={cacheKey}
      cacheKey={cacheKey}
      faviconUrl={renderableFaviconUrl}
      open={props.open}
      projectTitle={props.projectTitle}
      size={size}
    />
  );
}

function ProjectFaviconImage(props: {
  readonly cacheKey: string | null;
  readonly faviconUrl: string | null;
  readonly open?: boolean;
  readonly projectTitle: string;
  readonly size: number;
}) {
  const iconMuted = useThemeColor("--color-icon-subtle");
  const faviconRequest = useMemo(
    () => createProjectFaviconRequest(props.cacheKey, props.faviconUrl),
    [props.cacheKey, props.faviconUrl],
  );
  const [activeFaviconRequest, setActiveFaviconRequest] = useState<typeof faviconRequest>(null);
  useLayoutEffect(() => {
    if (faviconRequest === null) return;

    const endRequest = beginProjectFaviconRequest(faviconRequest);
    setActiveFaviconRequest(faviconRequest);
    return endRequest;
  }, [faviconRequest]);

  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    hasLoadedProjectFavicon(props.cacheKey) ? "loaded" : "loading",
  );

  const requestIsActive = faviconRequest !== null && activeFaviconRequest === faviconRequest;
  const showImage = requestIsActive && status === "loaded";

  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Folder icon fallback (matches web's FolderIcon) */}
      {!showImage ? (
        <SymbolView
          name={{ ios: "folder.fill", android: props.open ? "folder_open" : "folder" }}
          size={props.size * 0.78}
          tintColor={iconMuted}
          type="monochrome"
        />
      ) : null}

      {/* Favicon image (hidden until loaded) */}
      {requestIsActive ? (
        <Image
          key={faviconRequest.faviconUrl}
          source={{
            uri: faviconRequest.faviconUrl,
            cacheKey: faviconRequest.cacheKey,
          }}
          cachePolicy="memory-disk"
          recyclingKey={faviconRequest.cacheKey}
          accessibilityLabel={`${props.projectTitle} favicon`}
          style={{
            width: props.size,
            height: props.size,
            borderRadius: props.size * 0.16,
            ...(showImage ? {} : { position: "absolute" as const, opacity: 0 }),
          }}
          contentFit="contain"
          onLoad={() => {
            if (!markProjectFaviconLoaded(faviconRequest)) return;
            setStatus("loaded");
          }}
          onError={() => {
            if (!markProjectFaviconFailed(faviconRequest)) return;
            setStatus("error");
          }}
        />
      ) : null}
    </View>
  );
}
