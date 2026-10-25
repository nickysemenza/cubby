import { jobState } from "@cubby/schemas/job";
import { sql, type SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

/**
 * Leased image work by the device holding it. An image Job's lease token is
 * its current `ImageProcessingAttempt` id, and the attempt's executor names
 * the device (`executor.deviceId` is the install's `Device.installationId`).
 */
const leasedImageWork = (where: SQL | undefined) => sql`
  FROM "Job"
  JOIN "ImageProcessingAttempt" a ON a.id = "Job"."leaseToken"
  WHERE "Job".state = ${jobState.enum.running}
    AND "Job".key LIKE ${"image-processing:%"}
    ${where ? sql`AND ${where}` : sql``}`;

/** Live (unexpired) leases each install holds now. */
export async function liveLeasesByInstallation(
  db: Database | DrizzleTransaction,
  installationIds: readonly string[],
  now = new Date(),
): Promise<Map<string, number>> {
  if (!installationIds.length) return new Map();
  const result = await repositoryQueries(db).execute<{
    installationId: string;
    count: number;
  }>(sql`SELECT a.executor->>${"deviceId"} AS "installationId", count(*)::int AS count
    ${leasedImageWork(sql`"Job"."leaseExpiresAt" > ${now.toISOString()}::timestamp
      AND a.executor->>${"deviceId"} IN (${sql.join(
        installationIds.map((id) => sql`${id}`),
        sql`, `,
      )})`)}
    GROUP BY 1`);
  return new Map(result.rows.map((row) => [row.installationId, row.count]));
}

/**
 * The Job set's leased image work per executor, live and expired apart, so
 * the Apple queue can show what each device holds and flag lost leases.
 */
export async function imageLeasesByExecutor(
  db: Database | DrizzleTransaction,
  where: SQL | undefined,
  now = new Date(),
) {
  const at = sql`${now.toISOString()}::timestamp`;
  const result = await repositoryQueries(db).execute<{
    executor: string | null;
    live: number;
    expired: number;
  }>(sql`SELECT a.executor->>${"name"} AS executor,
      count(*) FILTER (WHERE "Job"."leaseExpiresAt" > ${at})::int AS live,
      count(*) FILTER (WHERE "Job"."leaseExpiresAt" IS NULL OR "Job"."leaseExpiresAt" <= ${at})::int AS expired
    ${leasedImageWork(where)}
    GROUP BY 1 ORDER BY 1`);
  return result.rows;
}
