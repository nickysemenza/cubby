import { describe, expect, it } from "vitest";

import {
  parseEntityEditBulkUpdateInput,
  parseEntityEditCreateInput,
  parseEntityEditUpdateInput,
} from "./mutation-data";

describe("entity editing mutation data", () => {
  it("applies the owner create and update schemas", async () => {
    expect(
      await parseEntityEditCreateInput("task", {
        name: "Wire shelves",
        trade: "building",
      }),
    ).toMatchObject({ name: "Wire shelves", status: "not_started" });
    expect(
      await parseEntityEditUpdateInput("task", { status: "done" }),
    ).toEqual({
      status: "done",
    });
    const transaction = {
      accountId: "FAC-4K7M",
      kind: "purchase",
      status: "pending",
      amount: 12,
    };
    await expect(
      parseEntityEditCreateInput("financialTransaction", {
        ...transaction,
        amount: 0,
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: ["amount"],
          message: "amount must be non-zero",
        }),
      ]),
    });
    await expect(
      parseEntityEditCreateInput("financialTransaction", {
        ...transaction,
        status: "posted",
        postedDate: null,
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["postedDate"] }),
      ]),
    });
    await expect(
      parseEntityEditUpdateInput("financialTransaction", {
        amount: 0,
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["amount"] }),
      ]),
    });
  });

  it("uses the derived bulk-update schema and excludes identity fields", async () => {
    expect(
      await parseEntityEditBulkUpdateInput("task", { status: "done" }),
    ).toEqual({
      status: "done",
    });
    await expect(
      parseEntityEditBulkUpdateInput("ingredient", { name: "Flour" }),
    ).rejects.toThrow(/Unrecognized key/);
    for (const usuallyOnHand of [true, false]) {
      expect(
        await parseEntityEditBulkUpdateInput("ingredient", { usuallyOnHand }),
      ).toEqual({ usuallyOnHand });
    }
    await expect(
      parseEntityEditBulkUpdateInput("recipe", { name: "Soup" }),
    ).rejects.toThrow(/Unrecognized key/);
    expect(
      await parseEntityEditBulkUpdateInput("recipe", {
        notes: "Synthetic shared note",
      }),
    ).toEqual({ notes: "Synthetic shared note" });
  });
});
