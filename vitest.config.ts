import { defineConfig, loadEnv } from "vite";
import path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode ?? "test", process.cwd(), "");
  if (!env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set (see .env.example)");
  return {
    resolve: { alias: { "@": path.resolve(__dirname, "src") } },
    test: {
      environment: "node",
      globalSetup: ["./tests/global-setup.ts"],
      fileParallelism: false,
      testTimeout: 60_000,
      hookTimeout: 120_000,
      env: { ...env, DATABASE_URL: env.TEST_DATABASE_URL, NODE_ENV: "test", OTP_PROVIDER: "memory" },
    },
  };
});
