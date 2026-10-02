import { execSync } from "child_process";
import { loadEnv } from "vite";

export default function setup() {
  const env = loadEnv("test", process.cwd(), "");
  const url = env.TEST_DATABASE_URL;
  if (!url || url === env.DATABASE_URL) throw new Error("Refusing to run tests: TEST_DATABASE_URL missing or equals DATABASE_URL");
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
}
