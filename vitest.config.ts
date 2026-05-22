import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
    setupFiles: ["src/helpers/setup.ts"],
    // Integration tests spawn real `claude --print` + msb sandboxes; transient
    // API/network hiccups occasionally surface under heavy parallelism.
    retry: 1,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
