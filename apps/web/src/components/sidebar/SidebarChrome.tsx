import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  GitPullRequestIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { Link, useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../environmentStage";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarLegendStrip } from "./SidebarLegendStrip";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const pillLabel =
    environmentIdentificationMode === "none"
      ? null
      : resolveEnvironmentIdentificationPillLabel(stageLabel);

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      <SidebarTrigger className="relative z-10 md:hidden" />
      <SidebarBrand />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 rounded-full px-1.5 text-muted-foreground"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </SidebarHeader>
  );
});

function SidebarBrand() {
  return (
    <Link
      aria-label="Go to threads"
      className="relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center gap-1.5 overflow-hidden rounded-md text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring md:flex"
      to="/"
    >
      <RasCodeWordmark />
      <span className="truncate text-sm font-medium tracking-tight text-muted-foreground">
        Code
      </span>
    </Link>
  );
}

function RasCodeWordmark() {
  return (
    <svg
      aria-label="RAS"
      className="h-4 w-auto shrink-0"
      viewBox="0 0 234 114"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="0" y="0" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="24" y="0" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="0" y="24" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="48" y="24" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="0" y="48" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="24" y="48" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="0" y="72" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="48" y="72" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="0" y="96" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="48" y="96" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="108" y="0" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="84" y="24" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="132" y="24" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="84" y="48" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="108" y="48" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="132" y="48" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="84" y="72" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="132" y="72" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="84" y="96" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="132" y="96" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="168" y="0" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="192" y="0" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="216" y="0" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="168" y="24" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="168" y="48" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="192" y="48" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="216" y="48" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="216" y="72" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="168" y="96" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="192" y="96" width="18" height="18" rx="3" fill="#F0C24B" />
      <rect x="216" y="96" width="18" height="18" rx="3" fill="#F0C24B" />
    </svg>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const currentFooterPage = useLocation({
    select: (location) =>
      /^\/settings(?:\/|$)/.test(location.pathname)
        ? "settings"
        : location.pathname === "/usage"
          ? "usage"
          : location.pathname === "/pull-requests"
            ? "pull-requests"
            : null,
  });
  const { environments } = useEnvironments();
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/pull-requests", search: { involvement: "all", state: "open" } });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, closeMobileSidebar, navigate]);

  return (
    <SidebarMenu className="flex-row items-center">
      {currentFooterPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<GitPullRequestIcon />}
              label="Pull Requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
          />
        </>
      )}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

/** `legendCounts` is omitted by sidebar implementations that do not partition
 * threads by console state; the legend strip is then left out entirely. */
export const SidebarChromeFooter = memo(function SidebarChromeFooter({
  legendCounts,
}: {
  legendCounts?: { readonly working: number; readonly waiting: number };
}) {
  return (
    <SidebarFooter className="p-[var(--sidebar-content-inset)]">
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      {legendCounts ? (
        <SidebarLegendStrip
          workingCount={legendCounts.working}
          waitingCount={legendCounts.waiting}
        />
      ) : null}
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
