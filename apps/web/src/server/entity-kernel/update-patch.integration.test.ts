/**
 * A kernel update is a patch: fields the command omits keep their stored
 * values, and only a write that changes something leaves an audit row and
 * moves `updatedAt`. Failure modes pinned here, for several entities whose
 * repositories assemble their update rows differently:
 *
 * - an omitted field is reset to its default or null by a later patch;
 * - a repeated identical patch, or an empty one, writes an audit row (or, for
 *   entities that already guarantee it, bumps `updatedAt`) as if it changed
 *   the record.
 */
import { and, eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { auditLog } from "~/server/db/schema";
import { createDevice } from "~/server/domains/device/repo/device";
import { updateThroughKernel } from "~/server/testing/entity-kernel";

type Patch = Record<string, string | number | boolean | null>;

const updatedItem = z.object({
  item: z.looseObject({ updatedAt: z.date() }),
});

describe("entity kernel update patch", () => {
  const ctx = withTestDb();

  const cases = [
    {
      entity: "vendor",
      create: () =>
        createRepoEntity(ctx, "vendor", { name: "Scalar patch vendor" }),
      seed: { notes: "Keep this note", website: "https://example.com" },
      patch: { name: "Renamed scalar vendor" },
      noopKeepsUpdatedAt: true,
    },
    {
      entity: "task",
      create: () =>
        createRepoEntity(ctx, "task", {
          trade: "other",
          name: "Scalar patch task",
        }),
      seed: { status: "in_progress" },
      patch: { name: "Renamed scalar task" },
      noopKeepsUpdatedAt: false,
    },
    {
      entity: "expense",
      create: () =>
        createRepoEntity(ctx, "expense", {
          trade: "plumbing",
          costType: "materials",
          name: "Scalar patch expense",
          cost: 42.5,
          date: "2026-01-15",
        }),
      seed: { notes: "Keep this note", url: "https://example.com/receipt" },
      patch: { name: "Renamed scalar expense" },
      noopKeepsUpdatedAt: false,
    },
    {
      entity: "device",
      create: () =>
        createDevice(
          ctx.db,
          {
            installationId: crypto.randomUUID(),
            name: "Scalar patch tablet",
            platform: "ios",
            appVersion: "1.0",
            osVersion: "18.0",
            automaticWork: true,
            remotePaused: false,
            ledgerPartyId: null,
          },
          ctx.actor,
        ),
      seed: { appVersion: "1.1" },
      patch: { remotePaused: true },
      noopKeepsUpdatedAt: false,
    },
  ] as const satisfies ReadonlyArray<{
    entity: string;
    create: () => Promise<{ output: { id: string }; entityId: string }>;
    seed: Patch;
    patch: Patch;
    noopKeepsUpdatedAt: boolean;
  }>;

  // Only Vendor keeps `updatedAt` on a no-op patch today; Task, Expense and
  // Device still move it (without an audit row), so only the audit contract
  // is shared across them.
  it.each(cases)(
    "$entity preserves omitted fields and audits only actual changes",
    async ({ entity, create, seed, patch, noopKeepsUpdatedAt }) => {
      const { output, entityId } = await create();
      const update = (data: Patch) =>
        updateThroughKernel(ctx.db, ctx.actor, entity, output.id, data);
      const updateAudits = () =>
        getDb(ctx.db)
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.entityKind, entity),
              eq(auditLog.entityId, entityId),
              eq(auditLog.action, "update"),
            ),
          );

      await update(seed);
      const changed = await update(patch);
      const changedItem = updatedItem.parse(changed).item;
      expect(changedItem).toMatchObject({ ...seed, ...patch });
      await expect(updateAudits()).resolves.toHaveLength(2);

      // Repeating the same patch, or sending none, is not a change.
      const repeated = await update(patch);
      const empty = await update({});
      await expect(updateAudits()).resolves.toHaveLength(2);
      for (const unchanged of [repeated, empty]) {
        const item = updatedItem.parse(unchanged).item;
        expect(item).toMatchObject({ ...seed, ...patch });
        // A case that keeps `updatedAt` must report the changing write's time.
        expect(
          noopKeepsUpdatedAt ? item.updatedAt : changedItem.updatedAt,
        ).toEqual(changedItem.updatedAt);
      }
    },
  );
});
