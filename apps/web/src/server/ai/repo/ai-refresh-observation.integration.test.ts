import {
  aiRefreshRunInput,
  aiRefreshProgress,
} from "@cubby/schemas/ai-evaluation";
import { runEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import { compiledRefreshManifest } from "~/server/ai/policy/refresh-manifest";
import { getDb } from "~/server/db/helpers";
import { run, user } from "~/server/db/schema";
import { systemActor } from "~/server/domains/run/repo/ensure-run";
import { dispatchAiRefreshDiscovery } from "~/server/workflows/ai-refresh-startup";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import {
  activateAiRefresh,
  readAiRefreshActivation,
  readAiDiscoveryCursor,
  saveAiDiscoveryCursor,
} from "./ai-refresh";

describe("application-owned AI feature observation", () => {
  const ctx = withTestDb();
  beforeEach(async () => {
    await getDb(ctx.db)
      .insert(user)
      .values({
        id: systemActor().userId,
        name: "Synthetic background actor",
        email: "synthetic-system@example.test",
        emailVerified: false,
      })
      .onConflictDoNothing();
  });
  it("creates one durable discovery Run across concurrent observations", async () => {
    const manifest = await compiledRefreshManifest();
    await Promise.all(
      Array.from({ length: 12 }, () =>
        activateAiRefresh(ctx.db, "synthetic-release-a", {
          enabled: true,
          manifest,
          startDiscovery: true,
        }),
      ),
    );
    const rows = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "ai_refresh"));
    expect(rows).toHaveLength(1);
    expect(aiRefreshRunInput.parse(rows[0]!.input).discovery).toBe(true);
    expect((await readAiRefreshActivation(ctx.db))?.discoveryRunId).toBe(
      rows[0]!.id,
    );
  });

  it("skips code-only redeploys, creates one new job for changed features and follows rollback versions", async () => {
    const manifest = await compiledRefreshManifest();
    const first = await activateAiRefresh(ctx.db, "synthetic-release-a", {
      enabled: true,
      manifest,
      startDiscovery: true,
    });
    const codeOnly = await activateAiRefresh(ctx.db, "synthetic-release-b", {
      enabled: true,
      manifest,
      startDiscovery: true,
    });
    expect(codeOnly.discoveryRunId).toBe(first.discoveryRunId);
    const changed = {
      ...manifest,
      "field-suggestion": {
        ...manifest["field-suggestion"]!,
        promptVersion: "synthetic-new-prompt",
      },
    };
    await saveAiDiscoveryCursor(ctx.db, {
      field: null,
      email: "00000000-0000-4000-8000-000000000123",
    });
    const next = await activateAiRefresh(ctx.db, "synthetic-release-c", {
      enabled: true,
      manifest: changed,
      startDiscovery: true,
    });
    expect(next.discoveryRunId).not.toBe(first.discoveryRunId);
    expect(await readAiDiscoveryCursor(ctx.db)).toMatchObject({
      field: null,
      email: null,
    });
    expect(next.manifest["mailbox-triage"]).toEqual(
      first.manifest["mailbox-triage"],
    );
    const rollback = await activateAiRefresh(ctx.db, "synthetic-release-a", {
      enabled: true,
      manifest,
      startDiscovery: true,
    });
    expect(rollback.discoveryRunId).not.toBe(first.discoveryRunId);
    expect(rollback.manifest["field-suggestion"]!.generation).toBe(
      first.manifest["field-suggestion"]!.generation + 2,
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.purpose, "ai_refresh")),
    ).toHaveLength(3);
  });

  it("records disabling without dispatching and gives re-enable its own discovery job", async () => {
    const manifest = await compiledRefreshManifest();
    const first = await activateAiRefresh(ctx.db, "synthetic-enabled", {
      enabled: true,
      manifest,
      startDiscovery: true,
    });
    const disabled = await activateAiRefresh(ctx.db, "synthetic-disabled", {
      enabled: false,
      manifest,
      startDiscovery: true,
    });
    expect(disabled.enabled).toBe(false);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.purpose, "ai_refresh")),
    ).toHaveLength(1);
    const resumed = await activateAiRefresh(ctx.db, "synthetic-resumed", {
      enabled: true,
      manifest,
      startDiscovery: true,
    });
    expect(resumed.discoveryRunId).not.toBe(first.discoveryRunId);
    expect(resumed.manifest).toEqual(first.manifest);
  });
  it("fences a delayed old coordinator after a new owner and permits rollback at a newer epoch", async () => {
    const manifest = await compiledRefreshManifest();
    await activateAiRefresh(ctx.db, "synthetic-a", {
      enabled: true,
      manifest,
      startDiscovery: true,
      observationEpoch: 1,
    });
    const changed = {
      ...manifest,
      "field-suggestion": {
        ...manifest["field-suggestion"]!,
        promptVersion: "synthetic-new-policy",
      },
    };
    const newest = await activateAiRefresh(ctx.db, "synthetic-b", {
      enabled: true,
      manifest: changed,
      startDiscovery: true,
      observationEpoch: 2,
    });
    await activateAiRefresh(ctx.db, "synthetic-a", {
      enabled: true,
      manifest,
      startDiscovery: true,
      observationEpoch: 1,
    });
    expect(await readAiRefreshActivation(ctx.db)).toEqual(newest);
    const rollback = await activateAiRefresh(ctx.db, "synthetic-a", {
      enabled: true,
      manifest,
      startDiscovery: true,
      observationEpoch: 3,
    });
    expect(rollback.manifest["field-suggestion"]!.generation).toBe(
      newest.manifest["field-suggestion"]!.generation + 1,
    );
  });

  it("resumes a saved startup attempt whose Workflow instance was never created", async () => {
    const activation = await activateAiRefresh(ctx.db, "synthetic-dispatch", {
      enabled: true,
      startDiscovery: true,
    });
    await getDb(ctx.db)
      .update(run)
      .set({ progress: aiRefreshProgress.parse({ attempt: 1 }) })
      .where(eq(run.id, runEntityId.parse(activation.discoveryRunId)));
    const created: unknown[] = [];
    await dispatchAiRefreshDiscovery(ctx.db, activation, {
      status: async () => ({ state: "missing", error: null }),
      terminate: async () => {},
      create: async (...args) => {
        created.push(args);
      },
    });
    expect(created).toHaveLength(1);
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runEntityId.parse(activation.discoveryRunId)));
    expect(owner!.progress).toMatchObject({ attempt: 2 });
    await dispatchAiRefreshDiscovery(ctx.db, activation, {
      status: async () => ({ state: "running", error: null }),
      terminate: async () => {},
      create: async () => {
        throw new Error("Healthy instances must not duplicate");
      },
    });
  });
  it("rejects cursor writes from a page that outlived its activation revision", async () => {
    const prior = await activateAiRefresh(ctx.db, "synthetic-cursor-a", {
      enabled: true,
      startDiscovery: true,
    });
    const current = await activateAiRefresh(ctx.db, "synthetic-cursor-b", {
      enabled: false,
      startDiscovery: true,
    });
    await saveAiDiscoveryCursor(ctx.db, {
      field: null,
      email: null,
      revision: current.revision,
    });
    expect(
      await saveAiDiscoveryCursor(ctx.db, {
        revision: prior.revision,
        field: null,
        email: "00000000-0000-4000-8000-000000000123",
      }),
    ).toBe(false);
    expect(await readAiDiscoveryCursor(ctx.db)).toMatchObject({
      revision: current.revision,
      field: null,
      email: null,
    });
  });
  it("automatic dispatch atomically preserves cancellation recorded after its ownership read", async () => {
    const activation = await activateAiRefresh(ctx.db, "synthetic-cancel", {
      enabled: true,
      startDiscovery: true,
    });
    const id = runEntityId.parse(activation.discoveryRunId);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "user_cancelled" })
      .where(eq(run.id, id));
    await expect(
      launchWorkflowRun(
        ctx.db,
        { runId: id, purpose: "ai_refresh", automatic: true },
        {
          status: async () => ({ state: "missing", error: null }),
          terminate: async () => {},
          create: async () => {},
        },
      ),
    ).rejects.toThrow(/cancelled Run/);
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, id)))[0]
        ?.failureCode,
    ).toBe("user_cancelled");
  });
});
