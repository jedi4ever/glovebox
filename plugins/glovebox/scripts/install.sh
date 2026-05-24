#!/usr/bin/env bash
# Install the glovebox plugin into Claude Code.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"

bash "$SCRIPT_DIR/preflight.sh"

claude plugin install --plugin-dir "$PLUGIN_DIR"
