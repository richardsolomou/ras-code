"use strict";

// The brand artwork lives in the repo-root `assets/` tree, outside this project,
// and the Expo config references it by absolute path. @expo/fingerprint hashes
// that path string, never the bytes behind it, so regenerating the icons leaves
// the fingerprint unchanged: the pipeline keeps publishing OTAs onto binaries
// whose compiled launch screen and app icon still carry the old mark.
//
// The whole tree is one source rather than the handful of files a single variant
// embeds, because `icons:export` rewrites every variant together — a per-variant
// list would only add a way for the two to drift apart.
/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  extraSources: [
    {
      type: "dir",
      filePath: "../../assets",
      reasons: ["ras-code-brand-assets"],
    },
  ],
};
