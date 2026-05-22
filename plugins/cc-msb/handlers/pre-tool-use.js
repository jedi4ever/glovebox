#!/usr/bin/env node
// Called by hooks/pre-tool-use.sh for tools that need MSB sandbox enforcement.
// Reads hook event JSON from stdin, exits 0 (allow) or 2 (block).
import { readFileSync } from "node:fs";

const raw = readFileSync("/dev/stdin", "utf8");
const event = JSON.parse(raw);

// Placeholder — MSB SDK integration goes here.
const allow = true;

if (!allow) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: "blocked by cc-msb" }) + "\n");
  process.exit(2);
}

process.exit(0);
