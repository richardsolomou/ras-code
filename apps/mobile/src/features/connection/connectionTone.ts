import type { StatusTone } from "../../components/StatusPill";
import type { RemoteClientConnectionState } from "../../lib/connection";

export function connectionTone(state: RemoteClientConnectionState): StatusTone {
  switch (state) {
    case "connected":
      return {
        label: "Connected",
        pillClassName: "bg-[#2f8f4a]/12 dark:bg-[#52c46f]/16",
        textClassName: "text-[#2f8f4a] dark:text-[#52c46f]",
      };
    case "reconnecting":
      return {
        label: "Reconnecting",
        pillClassName: "bg-[#8a6a12]/12 dark:bg-[#f0c24b]/16",
        textClassName: "text-[#8a6a12] dark:text-[#f0c24b]",
      };
    case "connecting":
      return {
        label: "Connecting",
        pillClassName: "bg-[#8a6a12]/12 dark:bg-[#f0c24b]/16",
        textClassName: "text-[#8a6a12] dark:text-[#f0c24b]",
      };
    case "error":
      return {
        label: "Connection failed",
        pillClassName: "bg-[#b33a2f]/12 dark:bg-[#e5645a]/16",
        textClassName: "text-[#b33a2f] dark:text-[#e5645a]",
      };
    case "offline":
      return {
        label: "Offline",
        pillClassName: "bg-[#b33a2f]/12 dark:bg-[#e5645a]/16",
        textClassName: "text-[#b33a2f] dark:text-[#e5645a]",
      };
    case "available":
      return {
        label: "Available",
        pillClassName: "bg-subtle",
        textClassName: "text-foreground-muted",
      };
  }
}
