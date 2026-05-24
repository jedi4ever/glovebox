import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 180_000,
    globalSetup: ["src/helpers/global-setup.ts"],
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
