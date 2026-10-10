import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "@playwright/test";
import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { getDb } from "~/server/repo/database-helpers";

import { buildEntity } from "./factories/build";
import { retryStaleKeepAlive } from "./stale-keep-alive";
import { withTestDb } from "./test-setup";
import { withWorkerdRuntime } from "./workerd-runtime";

const ctx = withTestDb();

const censusGroup = z.object({
  state: z.string(),
  waitType: z.string(),
  sessions: z.number(),
  idleOver10Seconds: z.number(),
  idleOver30Seconds: z.number(),
  oldestBackendSeconds: z.number(),
  // A backend still starting up has no state yet, so its state_change is
  // null. It still holds a socket, so it stays in `sessions` and the totals.
  oldestStateSeconds: z.number().nullable(),
});

// Request pools can legitimately retain young idle clients for pg-pool's idle
// timeout (shortened here; production's is ten seconds). A background
// standalone client has no such idle timer: repeated freshness writes must not
// accumulate old idle sockets indefinitely. Each quiet window outlasts the
// pool's idle timeout, so only a socket nothing will ever close remains.
const POOL_IDLE_TIMEOUT_MS = 500;
const QUIET_MS = 3 * POOL_IDLE_TIMEOUT_MS;
it("real Worker reads and freshness writes release database sockets after quiet", async () => {
  await withWorkerdRuntime(
    {
      profile: "offline",
      database: { borrowed: ctx.databaseUrl },
      poolIdleTimeoutMs: POOL_IDLE_TIMEOUT_MS,
    },
    async ({ origin: baseURL }) => {
      const api = await request.newContext({
        baseURL,
        extraHTTPHeaders: { Origin: baseURL },
      });
      retryStaleKeepAlive(api);
      try {
        const signedUp = await api.post("/api/auth/sign-up/email", {
          data: {
            email: `socket-${randomUUID()}@example.test`,
            password: "synthetic-socket-password",
            name: "Synthetic Socket Member",
          },
        });
        expect({
          status: signedUp.status(),
          body: scrubErrorMessage(await signedUp.text()),
        }).toMatchObject({ status: 200 });
        const database = getDb(ctx.db);
        const samples: Array<{
          phase: string;
          total: number;
          groups: Array<z.output<typeof censusGroup>>;
        }> = [];
        const census = async (phase: string) => {
          const { rows } = await database.execute(sql`
      SELECT COALESCE(state, 'unknown') AS state,
        COALESCE(wait_event_type, 'none') AS "waitType",
        count(*)::int AS sessions,
        count(*) FILTER (WHERE state = 'idle' AND state_change < clock_timestamp() - interval '10 seconds')::int AS "idleOver10Seconds",
        count(*) FILTER (WHERE state = 'idle' AND state_change < clock_timestamp() - interval '30 seconds')::int AS "idleOver30Seconds",
        round(max(extract(epoch FROM clock_timestamp() - backend_start)))::int AS "oldestBackendSeconds",
        round(max(extract(epoch FROM clock_timestamp() - state_change)))::int AS "oldestStateSeconds"
      FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend'
        AND pid <> pg_backend_pid()
      GROUP BY 1, 2
    `);
          const groups = z.array(censusGroup).parse(rows);
          const sample = {
            phase,
            total: groups.reduce((sum, group) => sum + group.sessions, 0),
            groups,
          };
          samples.push(sample);
          return sample;
        };
        const reads = async () => {
          for (let batch = 0; batch < 4; batch++) {
            const responses = await Promise.all(
              Array.from({ length: 8 }, () => api.get("/api/v1/projects")),
            );
            for (const response of responses)
              expect({
                status: response.status(),
                body: scrubErrorMessage(await response.text()),
              }).toMatchObject({ status: 200 });
          }
        };
        try {
          await census("cold");
          const name = `Synthetic socket lifecycle ${randomUUID()}`;
          const created = await api.post("/api/v1/projects", {
            data: buildEntity("project", { name, kind: "household" }),
          });
          expect({
            status: created.status(),
            body: scrubErrorMessage(await created.text()),
          }).toMatchObject({ status: 201 });
          const id = z
            .object({ item: z.object({ id: z.string() }) })
            .parse(await created.json()).item.id;
          await reads();
          await census("warm load");
          // This delay observes real socket expiry, not readiness of a UI control.
          await delay(QUIET_MS);
          const baseline = await census("warm quiet");
          const quietSamples = [];
          for (let round = 1; round <= 3; round++) {
            const changed = await api.patch(`/api/v1/projects/${id}`, {
              data: { name: `${name} round ${round}` },
            });
            expect({
              status: changed.status(),
              body: scrubErrorMessage(await changed.text()),
            }).toMatchObject({ status: 200 });
            await reads();
            await census(`round ${round} load`);
            await delay(QUIET_MS);
            quietSamples.push(await census(`round ${round} quiet`));
          }
          for (const sample of quietSamples)
            expect(sample.total).toBeLessThanOrEqual(baseline.total);
        } catch (error) {
          console.error("postgres-socket-census", JSON.stringify(samples));
          throw error;
        }
      } finally {
        await api.dispose();
      }
    },
  );
}, 120_000);
