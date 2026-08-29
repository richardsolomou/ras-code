export * from "@ras-code/shared/advertisedEndpoint";

import { appendPathnameToBaseUrl } from "@ras-code/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(appendPathnameToBaseUrl(httpBaseUrl, pathname));
  url.search = "";
  url.hash = "";
  return url.toString();
};
