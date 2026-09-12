import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["private-test-reports/**", "github-release-staging/**", "skills/**"],
    testTimeout: 30_000,
  },
});
