#!/usr/bin/env bash
# Wrapper around `claude` that loads the glovebox plugin from this repo.
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../plugins/glovebox" && pwd)"
exec claude --plugin-dir "$PLUGIN_DIR" "$@"
