import { connectionStatusText } from "@ras-code/client-runtime/connection";
import type { EnvironmentId } from "@ras-code/contracts";
import { CloudIcon, LaptopIcon, MonitorIcon, TerminalIcon } from "lucide-react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { cn } from "../../lib/utils";
import type { EnvironmentPresentation } from "../../state/environments";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { providerSettingsTabClassName } from "./providerSettingsTabs";

export function settingsDeviceIcon(environment: EnvironmentPresentation) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return MonitorIcon;
  if (environment.entry.target._tag === "RelayConnectionTarget") return CloudIcon;
  if (environment.entry.target._tag === "SshConnectionTarget") return TerminalIcon;
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return LaptopIcon;
  return CloudIcon;
}

export function settingsDeviceDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  if (environment.relayManaged) return "RAS Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return "Local device";
  return environment.displayUrl ?? "Remote device";
}

/**
 * Device switcher for settings that are stored per environment.
 *
 * Renders nothing when the only device is the one serving this client: there
 * is nothing to switch between, and naming it would imply otherwise.
 */
export function SettingsDeviceTabs({
  options,
  environmentId,
  onSelect,
}: {
  readonly options: ReadonlyArray<EnvironmentPresentation>;
  readonly environmentId: EnvironmentId | null;
  readonly onSelect: (environmentId: EnvironmentId) => void;
}) {
  const onlyPrimaryDevice =
    options.length === 1 && options[0]?.entry.target._tag === "PrimaryConnectionTarget";
  if (options.length === 0 || onlyPrimaryDevice) {
    return null;
  }

  return (
    <ScrollArea hideScrollbars scrollFade className="h-11 min-w-0 rounded-none">
      <div
        role="group"
        aria-label="Devices"
        className="flex h-full w-max min-w-full border-b border-border/70 px-3 sm:px-4"
      >
        {options.map((environment) => {
          const Icon = settingsDeviceIcon(environment);
          const selected = environment.environmentId === environmentId;
          const detail = settingsDeviceDetail(environment);
          const statusText = connectionStatusText(environment.connection);
          return (
            <Tooltip key={environment.environmentId}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-pressed={selected}
                    className={cn(providerSettingsTabClassName(selected), "gap-2 text-left")}
                    onClick={() => onSelect(environment.environmentId)}
                  >
                    <Icon className="size-3.5 shrink-0" aria-hidden />
                    <span className="max-w-40 truncate">{environment.label}</span>
                    <ConnectionStatusDot
                      dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                      pingClassName={connectionPhasePingClassName(environment.connection.phase)}
                    />
                    <span className="sr-only">
                      {detail}, {statusText}
                    </span>
                  </button>
                }
              />
              <TooltipPopup side="top">
                {detail} · {statusText}
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </ScrollArea>
  );
}
