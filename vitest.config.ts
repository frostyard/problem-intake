import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Obvious fake secrets for local tests. Real values exist only in
      // Cloudflare (docs/runbook/deploy.md).
      miniflare: {
        bindings: {
          INTAKE_BEARER: "test-bearer-not-a-real-secret",
          GLITCHTIP_DSNS: JSON.stringify({
            system: "https://0123456789abcdef0123456789abcdef@glitchtip.test.invalid/1",
          }),
          AE_READ_TOKEN: "test-ae-token-not-real",
          CF_ACCOUNT_ID: "00000000000000000000000000000000",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      // Istanbul is the provider that instruments inside workerd.
      provider: "istanbul",
      include: ["src/**"],
      exclude: ["src/generated/**"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 90 },
    },
  },
});
