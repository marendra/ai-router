import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // Tests run inside workerd via @cloudflare/vitest-pool-workers so Durable
    // Object storage, RPC and outbound fetch mocking behave like production.
    // isolatedStorage (default true) gives every test a clean DO database.
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Test-only auth bindings. Provider upstreams are mocked via fetchMock;
          // no real provider is ever contacted and no real secret is needed.
          bindings: {
            GRUVIX_AI_ROUTER_KEY: "test-router-key",
            GRUVIX_AI_ROUTER_ADMIN_KEY: "test-admin-key",
            MODAL_BASE_URL: "http://modal.test/v1",
          },
        },
      },
    },
  },
});
