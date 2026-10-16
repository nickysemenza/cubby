import { eq, sql } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import { fieldSuggestSpecFor } from "~/server/ai/field-suggest/registry";
import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import { getDb } from "~/server/db/helpers";
import { financialAccount } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  kernelCtx,
  PRIMARY_MODEL,
  recordId,
  seedPending,
  startSuggestionSweep,
  runSuggestions,
  suggestion,
  suggestionStatus,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntity } from "~/server/entity-kernel";
import { acceptSuggestion } from "~/server/generic/assessment/repo/suggestion-review";

// Failure modes: scalar acceptance drops an identity sibling; a stale full-form
// identity undoes an accepted scalar; a raw identity write leaves advice pending;
// non-card projections or non-member holder assignments reach storage.
describe("Account scalar suggestion acceptance", () => {
  const ctx = withTestDb();

  it("saves a native capture after switching to cash without keeping card-only drafts", async () => {
    const result = await executeEntity(kernelCtx(ctx), {
      entity: "financialAccount",
      action: "create",
      data: buildEntity("financialAccount", {
        name: "Synthetic switched capture",
        identity: { kind: "cash" },
        issuer: "Synthetic Bank",
        network: "visa",
      }),
    });
    expect(result).toMatchObject({
      action: "create",
      item: { identity: { kind: "cash" }, issuer: null, network: null },
    });
  });

  it("refuses automatic acceptance of a declared review-required field at the shared sink", async () => {
    const account = await createRepoEntity(ctx, "financialAccount", {
      identity: { kind: "credit_card", issuer: null, network: null },
    });
    const pending = await seedPending(ctx, {
      entity: "financialAccount",
      recordId: await recordId(ctx.db, account.output.id, "financialAccount"),
      field: "network",
      currentValue: null,
      suggestedValue: "visa",
      kind: "addition",
    });
    await expect(
      acceptSuggestion(
        ctx.db,
        kernelCtx(ctx),
        { id: pending.id },
        { mode: "automatic", confidence: 0.99 },
      ),
    ).rejects.toThrow("requires member review");
    expect(await suggestionStatus(ctx.db, pending.id)).toBe("pending");
    const [stored] = await getDb(ctx.db)
      .select({ identity: financialAccount.identity })
      .from(financialAccount)
      .where(eq(financialAccount.shortcode, account.output.id));
    expect(stored?.identity).toEqual({
      kind: "credit_card",
      issuer: null,
      network: null,
    });
  });

  it("keeps high-confidence card sweep additions pending until member review", async () => {
    const account = await createRepoEntity(ctx, "financialAccount", {
      identity: { kind: "credit_card", issuer: null, network: null },
      provisional: true,
    });
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "financialAccount",
        fields: ["network"],
        filters: { ids: [account.output.id] },
      },
      {
        context: kernelCtx(ctx),
        suggest: async () =>
          suggestion("network", {
            value: "visa",
            label: "Visa",
            probability: 0.99,
          }),
      },
    );
    const rows = await runSuggestions(ctx.db, started.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      field: "network",
      kind: "addition",
      status: "pending",
      suggestedValue: "visa",
      confidence: 0.99,
    });
    const [stored] = await getDb(ctx.db)
      .select({
        identity: financialAccount.identity,
        provisional: financialAccount.provisional,
      })
      .from(financialAccount)
      .where(eq(financialAccount.shortcode, account.output.id));
    expect(stored).toEqual({
      identity: { kind: "credit_card", issuer: null, network: null },
      provisional: true,
    });
  });

  it("prepares structured account identity for real sweep inference and leaves all reviewed fields pending", async () => {
    const member = await createRepoEntity(ctx, "ledgerParty", {
      name: "Avery Example",
      kind: "member",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic sweep card",
      identity: { kind: "credit_card", issuer: null, network: null },
      notes:
        "Issuer: Harbor Example Bank\nPrimary cardholder: Avery Example\nNetwork: Visa",
      provisional: true,
    });
    const decisionPort = vi.fn<DecisionPort>(async (input) => {
      expect(input.state).toContain("credit_card");
      const entries = Object.entries(input.questions.selection.criteria);
      const chosen = entries.find(
        ([, label]) =>
          label.includes(member.output.id) ||
          label.includes("Harbor Example Bank") ||
          label.toLowerCase().includes("visa"),
      );
      if (!chosen) throw new Error("Synthetic sweep choice missing");
      return {
        answers: {
          selection: {
            type: "choice",
            choice: chosen[0],
            confidence: 0.99,
            probabilities: Object.fromEntries(
              entries.map(([key]) => [
                key,
                key === chosen[0] ? 0.99 : 0.01 / (entries.length - 1),
              ]),
            ),
          },
        },
      };
    });
    const started = await startSuggestionSweep(
      ctx.db,
      {
        entity: "financialAccount",
        fields: ["issuer", "network", "primaryCardholderId"],
        filters: { ids: [account.output.id] },
      },
      { context: kernelCtx(ctx), suggestPorts: { decisionPort } },
    );
    expect(decisionPort).toHaveBeenCalledTimes(3);
    const rows = await runSuggestions(ctx.db, started.id);
    expect(rows.map(({ field, status }) => ({ field, status }))).toEqual(
      expect.arrayContaining([
        { field: "issuer", status: "pending" },
        { field: "network", status: "pending" },
        { field: "primaryCardholderId", status: "pending" },
      ]),
    );
    expect(rows).toHaveLength(3);
    const [stored] = await getDb(ctx.db)
      .select({
        identity: financialAccount.identity,
        primaryCardholderId: financialAccount.primaryCardholderId,
        provisional: financialAccount.provisional,
      })
      .from(financialAccount)
      .where(eq(financialAccount.shortcode, account.output.id));
    expect(stored).toEqual({
      identity: { kind: "credit_card", issuer: null, network: null },
      primaryCardholderId: null,
      provisional: true,
    });
  });

  it("offers all live members and saved issuers to the model, and accepts none for funding-only evidence", async () => {
    const first = await createRepoEntity(ctx, "ledgerParty", {
      name: "Avery Example",
      kind: "member",
    });
    const second = await createRepoEntity(ctx, "ledgerParty", {
      name: "Blair Sample",
      kind: "member",
    });
    await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic guest",
      kind: "guest",
    });
    await createRepoEntity(ctx, "financialAccount", {
      identity: {
        kind: "credit_card",
        issuer: "Synthetic Vocabulary Bank",
        network: null,
      },
    });
    const basis = {
      name: "Synthetic card",
      identity: '{"kind":"credit_card","issuer":null,"network":null}',
      notes:
        "Avery Example funds this card and made 90 purchases. Blair Sample is an authorized user.",
    };
    const holder = fieldSuggestSpecFor(
      "financialAccount",
      "primaryCardholderId",
    );
    if (holder?.kind !== "reference")
      throw new Error("Missing cardholder spec");
    const members = await holder.roster(ctx.db, basis, basis);
    expect(members).toEqual(
      expect.arrayContaining([
        { id: first.output.id, name: "Avery Example" },
        { id: second.output.id, name: "Blair Sample" },
      ]),
    );
    expect(members).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Synthetic guest" }),
      ]),
    );
    const decisionPort = vi.fn<DecisionPort>(async (input) => {
      const entries = Object.entries(input.questions.selection.criteria);
      return {
        answers: {
          selection: {
            type: "choice",
            choice: "none",
            confidence: 0.9,
            probabilities: Object.fromEntries(
              entries.map(([key]) => [
                key,
                key === "none" ? 0.9 : 0.1 / (entries.length - 1),
              ]),
            ),
          },
        },
      };
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const result = await suggestFields(
      ctx.db,
      runId,
      {
        entity: "financialAccount",
        targets: ["primaryCardholderId", "issuer"],
        basisMode: "provided",
        basis,
      },
      { decisionPort, decisionModel: PRIMARY_MODEL },
    );
    expect(decisionPort).toHaveBeenCalledTimes(2);
    expect(result.suggestions.primaryCardholderId).toBeNull();
    expect(result.suggestions.issuer).toBeNull();
    expect(result.outcomes).toMatchObject({
      primaryCardholderId: { kind: "evaluated", answer: "none" },
      issuer: { kind: "evaluated", answer: "none" },
    });
  });

  it("accepts issuer, network and primary holder through the kernel without changing histories or provisional status", async () => {
    const member = await createRepoEntity(ctx, "ledgerParty", {
      kind: "member",
    });
    const authorizedMember = await createRepoEntity(ctx, "ledgerParty", {
      kind: "member",
    });
    const originalHolder = await createRepoEntity(ctx, "ledgerParty", {
      kind: "member",
    });
    const histories = {
      authorizedUsers: [
        {
          ledgerPartyId: authorizedMember.output.id,
          validFrom: "2026-01-01",
          validTo: "2026-06-30",
        },
      ],
      fundingPeriods: [
        {
          ledgerPartyId: member.output.id,
          validFrom: "2025-01-01",
          validTo: null,
        },
      ],
      cardNumbers: [
        {
          last4: "4321",
          kind: "primary" as const,
          validFrom: "2025-01-01",
          validTo: null,
          note: "Synthetic history",
        },
      ],
    };
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic card",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      provisional: true,
      primaryCardholderId: originalHolder.output.id,
      ...histories,
      notes:
        "Issuer: Harbor Example Bank\nPrimary cardholder named in statement evidence",
    });
    const id = await recordId(ctx.db, account.output.id, "financialAccount");
    for (const [field, currentValue, suggestedValue] of [
      ["issuer", null, "Harbor Example Bank"],
      ["network", "visa", "mastercard"],
      ["primaryCardholderId", originalHolder.output.id, member.output.id],
    ] as const) {
      const pending = await seedPending(ctx, {
        entity: "financialAccount",
        recordId: id,
        field,
        currentValue,
        suggestedValue,
        kind: currentValue === null ? "addition" : "correction",
      });
      await acceptSuggestion(ctx.db, kernelCtx(ctx), { id: pending.id });
      expect(await suggestionStatus(ctx.db, pending.id)).toBe("applied");
    }
    const saved = await executeEntity(kernelCtx(ctx), {
      entity: "financialAccount",
      action: "get",
      id: account.output.id,
      missing: "error",
    });
    expect(saved).toMatchObject({
      item: {
        issuer: "Harbor Example Bank",
        network: "mastercard",
        identity: {
          kind: "credit_card",
          issuer: "Harbor Example Bank",
          network: "mastercard",
        },
        primaryCardholderId: member.output.id,
        provisional: true,
        ...histories,
      },
    });
    const advice = await seedPending(ctx, {
      entity: "financialAccount",
      recordId: id,
      field: "issuer",
      currentValue: "Harbor Example Bank",
      suggestedValue: "Meadow Example Bank",
      kind: "correction",
    });
    await getDb(ctx.db).execute(
      sql`UPDATE "FinancialAccount" SET identity = jsonb_set(identity, '{network}', '"visa"') WHERE id = ${id}`,
    );
    expect(await suggestionStatus(ctx.db, advice.id)).toBe("superseded");
  });

  it("rejects non-card scalar writes and refuses a guest as primary cardholder", async () => {
    const cash = await createRepoEntity(ctx, "financialAccount", {
      identity: { kind: "cash" },
    });
    const guest = await createRepoEntity(ctx, "ledgerParty", { kind: "guest" });
    for (const data of [
      { issuer: "Synthetic Bank" },
      { network: "visa" },
      { primaryCardholderId: guest.output.id },
    ] as const) {
      await expect(
        executeEntity(kernelCtx(ctx), {
          entity: "financialAccount",
          action: "update",
          id: cash.output.id,
          data,
        }),
      ).rejects.toThrow(/credit-card accounts|live member ledger party/);
    }
    const [stored] = await getDb(ctx.db)
      .select({ identity: financialAccount.identity })
      .from(financialAccount)
      .where(eq(financialAccount.shortcode, cash.output.id));
    expect(stored?.identity).toEqual({ kind: "cash" });
  });
});
