import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					JWT_SECRET: "test-jwt-secret",
					CRED_PEPPER: "test-pepper",
					LINE_CHANNEL_ID: "1234567890",
					ALLOWED_ORIGINS: "https://admin.example.com, https://liff.example.com",
					TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "../AAASQL/migrations")),
				},
			},
		})),
	],
	test: { setupFiles: ["./test/apply-migrations.ts"] },
});
