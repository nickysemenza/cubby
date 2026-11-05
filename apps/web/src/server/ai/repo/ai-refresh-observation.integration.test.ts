import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import { compiledRefreshManifest } from "~/server/ai/policy/refresh-manifest";
import { getDb } from "~/server/db/helpers";
import { user } from "~/server/db/schema";
import {
  readMailImportSettings,
  setMailImport,
} from "~/server/domains/purchase-import/repo/mail-import-settings";
import { systemActor } from "~/server/domains/run/repo/ensure-run";

import {
  activateAiRefresh,
  admitAiRefreshDeployment,
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
  it("activates once per deployment occurrence, fences old cron work and keeps mail controls", async () => {
    const mailboxId = "synthetic-mailbox";
    await setMailImport(ctx.db, { mailboxId, enabled: true });
    let current = "synthetic-version-a";
    const readVersion = async () => current;
    const admit = (version: string, release: string) =>
      admitAiRefreshDeployment(ctx.db, version, release, readVersion);
    const first = await admit(current, "synthetic-commit-a");
    if (!first) throw new Error("Expected deployment activation");
    expect(await admit(current, "synthetic-commit-a")).toBeNull();
    current = "synthetic-version-b";
    expect(await admit("synthetic-version-a", "synthetic-commit-a")).toBeNull();
    expect(await admit(current, "synthetic-commit-b")).not.toBeNull();
    current = "synthetic-version-a";
    const restored = await admit(current, "synthetic-commit-a");
    expect(restored?.observationEpoch).toBeGreaterThan(first.observationEpoch);
    expect(await readMailImportSettings(ctx.db)).toEqual({
      enabledMailboxes: [mailboxId],
      controlledPauses: [],
    });
    await setMailImport(ctx.db, { mailboxId, enabled: false });
    expect(await admit(current, "synthetic-commit-a")).toBeNull();
    expect(restored?.manifest).toEqual(first.manifest);
  });

  it("skips code-only redeploys, restarts discovery for changed features and follows rollback versions", async () => {
    const manifest = await compiledRefreshManifest();
    const first = await activateAiRefresh(ctx.db, "synthetic-release-a", {
      enabled: true,
      manifest,
      startDiscovery: true,
    });
    await activateAiRefresh(ctx.db, "synthetic-release-b", {
      enabled: true,
      manifest,
      startDiscovery: true,
    });
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
    expect(rollback.manifest["field-suggestion"]!.generation).toBe(
      first.manifest["field-suggestion"]!.generation + 2,
    );
  });

  it("records disabling without dispatching and restarts discovery on re-enable", async () => {
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
    const resumed = await activateAiRefresh(ctx.db, "synthetic-resumed", {
      enabled: true,
      manifest,
      startDiscovery: true,
    });
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
});
