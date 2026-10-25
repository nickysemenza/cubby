import type { FinancialAccountUpdateData } from "@cubby/schemas/financial-account";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { listFinancialAccounts } from "~/server/domains/financial-account/repo";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntity } from "~/server/entity-kernel";

describe("account cardholder inheritance", () => {
  const ctx = withTestDb();
  it("follows a member owner while preserving explicit choices and None", async () => {
    const first = await createRepoEntity(ctx, "ledgerParty", {
      kind: "member",
      name: "Synthetic first member",
    });
    const second = await createRepoEntity(ctx, "ledgerParty", {
      kind: "member",
      name: "Synthetic second member",
    });
    const card = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic inherited card",
      identity: { kind: "credit_card", network: "visa" },
      ledgerPartyId: first.output.id,
    });
    expect(card.output).toMatchObject({
      primaryCardholderId: first.output.id,
      fieldResolutions: {
        primaryCardholderId: { mode: "inherit", canReset: false },
      },
    });
    const update = async (data: FinancialAccountUpdateData) => {
      await executeEntity(kernelCtx(ctx), {
        entity: "financialAccount",
        action: "update",
        id: card.output.id,
        data,
      });
      return executeEntity(kernelCtx(ctx), {
        entity: "financialAccount",
        action: "get",
        id: card.output.id,
        missing: "error",
      });
    };
    expect(await update({ ledgerPartyId: second.output.id })).toMatchObject({
      item: { primaryCardholderId: second.output.id },
    });
    expect(
      await update({ primaryCardholderId: first.output.id }),
    ).toMatchObject({
      item: {
        primaryCardholderId: first.output.id,
        fieldResolutions: { primaryCardholderId: { mode: "explicit" } },
      },
    });
    expect(
      await update({
        primaryCardholderId: null,
        primaryCardholderMode: "explicit",
      }),
    ).toMatchObject({
      item: {
        primaryCardholderId: null,
        fieldResolutions: { primaryCardholderId: { mode: "none" } },
      },
    });
    expect(
      await update({
        primaryCardholderId: null,
        primaryCardholderMode: "inherit",
      }),
    ).toMatchObject({ item: { primaryCardholderId: second.output.id } });
    const filtered = await listFinancialAccounts(
      ctx.db,
      { primaryCardholderId: [second.output.id] },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(filtered.data.map((row) => row.id)).toContain(card.output.id);
    const excluded = await listFinancialAccounts(
      ctx.db,
      { primaryCardholderId: [first.output.id] },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(excluded.data.map((row) => row.id)).not.toContain(card.output.id);
  });
  it.each(["household"] as const)(
    "does not inherit a %s owner",
    async (kind) => {
      const owner = await createRepoEntity(ctx, "ledgerParty", {
        kind,
        name: `Synthetic ${kind}`,
      });
      const card = await createRepoEntity(ctx, "financialAccount", {
        identity: { kind: "credit_card", network: null },
        ledgerPartyId: owner.output.id,
      });
      expect(card.output.primaryCardholderId).toBeNull();
    },
  );
  it("validates authorized users against the effective member cardholder", async () => {
    const primary = await createRepoEntity(ctx, "ledgerParty", {
      kind: "member",
      name: "Synthetic inherited primary",
    });
    const authorized = await createRepoEntity(ctx, "ledgerParty", {
      kind: "member",
      name: "Synthetic authorized member",
    });
    const card = await createRepoEntity(ctx, "financialAccount", {
      identity: { kind: "credit_card", network: null },
      ledgerPartyId: primary.output.id,
      authorizedUsers: [
        { ledgerPartyId: authorized.output.id, validFrom: null, validTo: null },
      ],
    });
    expect(card.output.primaryCardholderId).toBe(primary.output.id);
    await expect(
      createRepoEntity(ctx, "financialAccount", {
        identity: { kind: "credit_card", network: null },
        ledgerPartyId: primary.output.id,
        authorizedUsers: [
          { ledgerPartyId: primary.output.id, validFrom: null, validTo: null },
        ],
      }),
    ).rejects.toThrow(/primary cardholder/i);
  });
  it("rejects a household as an explicit primary cardholder", async () => {
    const household = await createRepoEntity(ctx, "ledgerParty", {
      kind: "household",
      name: "Synthetic household",
    });
    const card = await createRepoEntity(ctx, "financialAccount", {
      identity: { kind: "credit_card", network: null },
    });
    await expect(
      executeEntity(kernelCtx(ctx), {
        entity: "financialAccount",
        action: "update",
        id: card.output.id,
        data: { primaryCardholderId: household.output.id },
      }),
    ).rejects.toThrow(/live member ledger party/);
    await expect(
      createRepoEntity(ctx, "financialAccount", {
        identity: { kind: "credit_card", network: null },
        primaryCardholderId: household.output.id,
      }),
    ).rejects.toThrow(/live member ledger party/);
  });
  it("does not inherit card-only fields on bank accounts", async () => {
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      kind: "member",
      name: "Synthetic bank member",
    });
    const bank = await createRepoEntity(ctx, "financialAccount", {
      identity: { kind: "bank_account", accountType: "checking" },
      ledgerPartyId: owner.output.id,
    });
    expect(bank.output).toMatchObject({
      primaryCardholderId: null,
      network: null,
    });
  });
});
