import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secret — encryption.ts reads this at module load. Tests
    // never hit a real Supabase service, so any 32-byte hex string
    // will do; keep it lexically identical to the CI build env so
    // behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
    },
    clearMocks: true,
  },
});
