import { defineConfig } from "vitest/config";

const SHARED = {
  environment: "node" as const,
  globals: false,
  testTimeout: 180_000,
  setupFiles: ["src/helpers/setup.ts"],
  retry: 1,
};

export default defineConfig({
  test: {
    globalSetup: ["src/helpers/global-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
    projects: [
      {
        // Unit tests: no MSB sandboxes, run fully in parallel.
        test: {
          ...SHARED,
          name: "unit",
          include: ["src/tests/unit/**/*.test.ts"],
        },
      },
      {
        // Integration tests: each spawns real claude + MSB VMs.
        // Cap concurrent files to avoid exhausting macOS Virtualization.framework
        // (too many concurrent VmCreate calls fail with Internal(VmSetup(VmCreate))).
        test: {
          ...SHARED,
          name: "integration",
          include: ["src/tests/*.test.ts"],
          pool: "forks",
          poolOptions: {
            forks: {
              maxForks: 4,
            },
          },
        },
      },
    ],
  },
});
