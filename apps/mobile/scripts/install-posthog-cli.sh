#!/bin/bash
# posthog-react-native's Xcode build phase uploads sourcemaps and exits 1 when it
# cannot find posthog-cli, which fails the whole iOS build. EAS images do not
# ship the CLI, so install it here.
#
# The phase probes $HOME/.posthog/posthog-cli first, then the npm global bin,
# then `npm root`/.bin, then PATH. Only the first is reachable from Xcode's
# minimal environment without assuming npm is on its PATH, so link the installed
# binary into place rather than relying on the later probes.

set -euo pipefail

VERSION="0.16.1"

npm install --global "@posthog/cli@${VERSION}"

global_bin="$(npm prefix -g)/bin/posthog-cli"
if [ ! -x "$global_bin" ]; then
  echo "error: @posthog/cli@${VERSION} installed but ${global_bin} is not executable"
  exit 1
fi

mkdir -p "${HOME:?}/.posthog"
ln -sf "$global_bin" "${HOME:?}/.posthog/posthog-cli"

"${HOME:?}/.posthog/posthog-cli" --version
