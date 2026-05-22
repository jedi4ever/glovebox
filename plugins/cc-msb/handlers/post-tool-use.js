#!/usr/bin/env node
// Called by hooks/post-tool-use.sh for post-execution sandbox audit/cleanup.
import { readFileSync } from "node:fs";

const raw = readFileSync("/dev/stdin", "utf8");
const _event = JSON.parse(raw);

// Placeholder — MSB SDK teardown goes here.
process.exit(0);
