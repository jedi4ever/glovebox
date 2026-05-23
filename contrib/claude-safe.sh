#!/usr/bin/env bash
# Wrapper around `claude` that loads the cc-msb plugin from this repo.
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../plugins/cc-msb" && pwd)"
exec claude --plugin-dir "$PLUGIN_DIR" "$@"
