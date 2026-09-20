/**
 * Manual live smoke test against a DEPLOYED Gruuvix AI Router using the official
 * OpenAI SDK. Never run automatically in CI (it spends a tiny amount of money).
 *
 * Usage:
 *   GRUVIX_AI_ROUTER_URL=https://gruuvix-ai-router.<subdomain>.workers.dev \
 *   GRUVIX_AI_ROUTER_KEY=<key> \
 *   npm run smoke
 *
 * Keeps completion token usage tiny (max_tokens: 16).
 */
import OpenAI from "openai";

const baseURL = `${process.env.GRUVIX_AI_ROUTER_URL?.replace(/\/+$/, "")}/v1`;
const apiKey = process.env.GRUVIX_AI_ROUTER_KEY;

if (!baseURL || !apiKey) {
  console.error(
    "Set GRUVIX_AI_ROUTER_URL and GRUVIX_AI_ROUTER_KEY before running the smoke test.",
  );
  process.exit(1);
}

const client = new OpenAI({ baseURL, apiKey, maxRetries: 0 });
const MODEL = "gpt-oss-120b";
const MESSAGES = [{ role: "user" as const, content: "Reply with the single word: ok" }];

interface Result {
  test: string;
  provider?: string;
  status: string;
  latencyMs: number;
}

const results: Result[] = [];

async function main(): Promise<void> {
  console.log(`Smoke testing ${baseURL} (tiny requests, max_tokens=16)\n`);

  // 1. models
  let t0 = Date.now();
  const models = await client.models.list();
  const modelIds = [...models.data].map((m) => m.id);
  results.push({
    test: "GET /v1/models",
    status: modelIds.includes(MODEL) ? "pass" : "fail",
    latencyMs: Date.now() - t0,
  });

  // 2. non-streaming
  t0 = Date.now();
  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: MESSAGES,
    max_tokens: 16,
  });
  results.push({
    test: "POST /v1/chat/completions (non-streaming)",
    provider: completion.model,
    status: completion.choices[0]?.message?.content ? "pass" : "fail",
    latencyMs: Date.now() - t0,
  });

  // 3. streaming
  t0 = Date.now();
  const stream = await client.chat.completions.create({
    model: MODEL,
    messages: MESSAGES,
    max_tokens: 16,
    stream: true,
  });
  let chunks = 0;
  for await (const _chunk of stream) chunks += 1;
  results.push({
    test: "POST /v1/chat/completions (streaming)",
    status: chunks > 0 ? `pass (${chunks} chunks)` : "fail (no chunks)",
    latencyMs: Date.now() - t0,
  });

  // 4. several short requests — exercises round robin
  t0 = Date.now();
  const roundRobin = await Promise.all(
    [1, 2, 3].map((i) =>
      client.chat.completions.create({
        model: MODEL,
        messages: [{ role: "user", content: `Reply with the single word: ${i}` }],
        max_tokens: 16,
      }),
    ),
  );
  results.push({
    test: "3 concurrent short completions",
    status: roundRobin.every((r) => r.choices[0]?.message?.content) ? "pass" : "fail",
    latencyMs: Date.now() - t0,
  });

  console.table(results);
  const failed = results.filter((r) => r.status.startsWith("fail"));
  if (failed.length > 0) {
    console.error(`${failed.length} smoke test(s) FAILED`);
    process.exit(2);
  }
  console.log("All smoke tests passed.");
}

main().catch((err: unknown) => {
  console.error("Smoke test failed:", err instanceof Error ? err.message : err);
  process.exit(2);
});
