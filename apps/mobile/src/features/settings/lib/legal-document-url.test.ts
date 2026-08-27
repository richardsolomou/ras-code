import { describe, expect, it } from "vite-plus/test";

import { isLegalDocumentUrl } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each([
    "https://github.com/richardsolomou/ras-code/legal",
    "https://github.com/richardsolomou/ras-code/legal/",
    "https://github.com/richardsolomou/ras-code/privacy-policy?source=app",
    "https://github.com/richardsolomou/ras-code/terms-of-service#updates",
    "https://github.com/richardsolomou/ras-code/security-policy",
  ])("allows a configured legal document: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(true);
  });

  it.each([
    "https://github.com/richardsolomou/ras-code/download",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});
