/**
 * Lease SQL helpers. Active concurrency is always DERIVED from the leases table —
 * there is no separate mutable counter that could drift.
 */
import type { Lease } from "../types/provider";

type Sql = SqlStorage;

export function purgeExpiredLeases(sql: Sql, now: number): void {
  sql.exec("DELETE FROM leases WHERE expires_at <= ?", now);
}

export function activeCountsByProvider(sql: Sql): Map<string, number> {
  const counts = new Map<string, number>();
  const rows = [
    ...sql.exec("SELECT provider_id, COUNT(*) AS n FROM leases GROUP BY provider_id"),
  ] as { provider_id: string; n: number }[];
  for (const row of rows) counts.set(row.provider_id, row.n);
  return counts;
}

export function countActiveLeases(sql: Sql, providerId: string): number {
  const rows = [
    ...sql.exec("SELECT COUNT(*) AS n FROM leases WHERE provider_id = ?", providerId),
  ] as { n: number }[];
  return (rows[0] as { n: number }).n;
}

export function insertLease(sql: Sql, lease: Lease): void {
  sql.exec(
    "INSERT INTO leases (lease_id, provider_id, request_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    lease.leaseId,
    lease.providerId,
    lease.requestId,
    lease.createdAt,
    lease.expiresAt,
  );
}

/** Idempotent release: returns true only if the lease existed (first release). */
export function deleteLease(sql: Sql, leaseId: string): boolean {
  const cursor = sql.exec("DELETE FROM leases WHERE lease_id = ?", leaseId);
  return cursor.rowsWritten > 0;
}
