import { setTimeout as delay } from "node:timers/promises";
import { projectCreateInput } from "@cubby/schemas/project";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { getDb } from "~/server/repo/database-helpers";

import { createEvidenceHarnessContext } from "./fixtures-core";
import { uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const censusGroup = z.object({
  state: z.string(),
  waitType: z.string(),
  sessions: z.number(),
  idleOver10Seconds: z.number(),
  idleOver30Seconds: z.number(),
  oldestBackendSeconds: z.number(),
  oldestStateSeconds: z.number(),
});

// Request pools can legitimately retain young idle clients for pg-pool's ten
// second timeout. A background standalone client has no such idle timer:
// repeated freshness writes must not accumulate old idle sockets indefinitely.
test("real Worker reads and freshness writes release database sockets after quiet", async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const { db } = await createEvidenceHarnessContext(page);
  const database = getDb(db);
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
        Array.from({ length: 8 }, () => page.request.get("/api/v1/projects")),
      );
      for (const response of responses)
        expect(
          response.status(),
          scrubErrorMessage(await response.text()),
        ).toBe(200);
    }
  };
  try {
    await census("cold");
    const name = uniqueName(testInfo, "Synthetic socket lifecycle");
    const created = await page.request.post("/api/v1/projects", {
      headers: { Origin: baseURL! },
      data: projectCreateInput.parse({ name, kind: "household" }),
    });
    expect(created.status(), scrubErrorMessage(await created.text())).toBe(201);
    const id = z
      .object({ item: z.object({ id: z.string() }) })
      .parse(await created.json()).item.id;
    await reads();
    await census("warm load");
    // This delay observes real socket expiry, not readiness of a UI control.
    await delay(12_000);
    const baseline = await census("warm quiet");
    const quietSamples = [];
    for (let round = 1; round <= 3; round++) {
      const changed = await page.request.patch(`/api/v1/projects/${id}`, {
        headers: { Origin: baseURL! },
        data: { name: `${name} round ${round}` },
      });
      expect(changed.status(), scrubErrorMessage(await changed.text())).toBe(
        200,
      );
      await reads();
      await census(`round ${round} load`);
      await delay(12_000);
      quietSamples.push(await census(`round ${round} quiet`));
    }
    for (const sample of quietSamples)
      expect(sample.total, JSON.stringify(samples)).toBeLessThanOrEqual(
        baseline.total,
      );
  } finally {
    await testInfo.attach("postgres-socket-census", {
      body: Buffer.from(JSON.stringify(samples, null, 2)),
      contentType: "application/json",
    });
  }
});
