import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  git: {
    deploymentEnabled: false,
  },
  installCommand: "npm install -g vite-plus && vp install --filter '@ras-code/marketing...'",
  buildCommand: "vp run --filter @ras-code/marketing build",
  outputDirectory: "dist",
};
