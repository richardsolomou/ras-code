export * from "@t3tools/shared/advertisedEndpoint";

import { appendPathnameToBaseUrl } from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  const url = new URL(appendPathnameToBaseUrl(httpBaseUrl, pathname));
  url.search = "";
  url.hash = "";
  return url.toString();
};
