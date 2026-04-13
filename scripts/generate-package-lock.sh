#!/usr/bin/env bash
# Copyright 2026 Tim Perkins (tjwp) | SPDX-License-Identifier: Apache-2.0
#
# Generate package-lock.json from package.json for npm-based packaging.
# Runs npm in a temp directory to avoid conflicts with pnpm's node_modules.
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"

# Resolve the real npm bundled with the current node installation,
# bypassing any wrapper scripts that may block npm in pnpm-only environments.
node_bin="$(dirname "$(node -e "process.stdout.write(process.execPath)")")"
real_npm="${node_bin}/npm"
if [ ! -x "$real_npm" ]; then
  # Fallback: try npm-cli.js directly from node's lib
  real_npm="$(node -e "process.stdout.write(require('path').resolve(process.execPath, '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))")"
  if [ ! -f "$real_npm" ]; then
    echo "Error: Could not find npm bundled with node at $node_bin" >&2
    exit 1
  fi
  real_npm="node $real_npm"
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

cp "$project_dir/package.json" "$tmpdir/"
# Clear npm environment variables that the outer npm may have set,
# which can interfere with running a nested npm install.
(cd "$tmpdir" && env -i HOME="$HOME" PATH="$PATH" $real_npm install --package-lock-only --ignore-scripts)
cp "$tmpdir/package-lock.json" "$project_dir/package-lock.json"
echo "Generated package-lock.json" >&2
