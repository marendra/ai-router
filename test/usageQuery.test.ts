/**
 * /v1/usage: range parsing (pure) + graceful degradation when the ledger binding is
 * absent (tests/local run without the production-only USAGE_DB binding).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { parseUsageRange } from "../src/routes/usageQuery";
import { ROUTER_KEY, activateFetchMock, deactivateFetchMock } from "./helpers";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const DAY = 86_400_000;

describe("usage range parsing", () => {
  const url = (qs: string): URL => new URL(`http://x/v1/usage${qs}`);

  it("defaults to the last 7 days", () => {
    const r = parseUsageRange(url(""), NOW);
    expect(r).toEqual({ from: NOW - 7 * DAY, to: NOW });
  });

  it("treats date-only bounds as inclusive days in UTC", () => {
    const r = parseUsageRange(url("?from=2026-09-01&to=2026-09-03"), NOW);
    expect(r).toEqual({
      from: Date.parse("2026-09-01T00:00:00.000Z"),
      to: Date.parse("2026-09-04T00:00:00.000Z"), // to is inclusive
    });
  });

  it("aligns date-only bounds to the requested timezone (tz=7 → WIB)", () => {
    const r = parseUsageRange(url("?from=2026-09-01&to=2026-09-03&tz=7"), NOW);
    expect(r).toEqual({
      from: Date.parse("2026-09-01T00:00:00.000Z") - 7 * 3_600_000, // 00:00 WIB
      to: Date.parse("2026-09-04T00:00:00.000Z") - 7 * 3_600_000, // inclusive 09-03 WIB
    });
  });

  it("ignores out-of-range or garbage tz values", () => {
    expect(parseUsageRange(url("?tz=99&from=2026-09-01"), NOW)).toEqual(
      parseUsageRange(url("?from=2026-09-01"), NOW),
    );
    expect(parseUsageRange(url("?tz=abc"), NOW)).toEqual(
      parseUsageRange(url(""), NOW),
    );
  });

  it("accepts ISO datetimes", () => {
    const r = parseUsageRange(
      url("?from=2026-09-01T08:30:00Z&to=2026-09-02T09:00:00Z"),
      NOW,
    );
    expect(r).toEqual({
      from: Date.parse("2026-09-01T08:30:00Z"),
      to: Date.parse("2026-09-02T09:00:00Z"),
    });
  });

  it("rejects inverted, malformed, and oversized ranges", () => {
    expect(parseUsageRange(url("?from=2026-09-05&to=2026-09-01"), NOW)).toBe("invalid");
    expect(parseUsageRange(url("?from=not-a-date"), NOW)).toBe("invalid");
    expect(parseUsageRange(url("?from=2026-01-01&to=2026-09-20"), NOW)).toBe("invalid"); // > 92 days
  });
});

describe("/v1/usage endpoint", () => {
  beforeEach(activateFetchMock);
  afterEach(deactivateFetchMock);

  it("requires the router key", async () => {
    const res = await SELF.fetch("http://router.internal/v1/usage?from=2026-09-01");
    expect(res.status).toBe(401);
  });

  it("answers 503 (not a crash) when the ledger binding is absent, 400 on bad ranges", async () => {
    const keyHeaders = { Authorization: `Bearer ${ROUTER_KEY}` };
    const noLedger = await SELF.fetch("http://router.internal/v1/usage", { headers: keyHeaders });
    expect(noLedger.status).toBe(503);

    const badRange = await SELF.fetch("http://router.internal/v1/usage?from=garbage", {
      headers: keyHeaders,
    });
    expect(badRange.status).toBe(400);
  });
});
