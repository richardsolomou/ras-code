import type { APIRoute } from "astro";

import { buildRasProjectFileJsonSchema } from "@ras-code/shared/rasProjectFile";

// Rendered at build time; published at /schema/ras.json so ras.json files can
// reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildRasProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
