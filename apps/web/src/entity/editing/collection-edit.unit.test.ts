import { describe, expect, it } from "vitest";

import {
  collectionDraft,
  collectionWireValue,
  type CollectionDraft,
  type CollectionRow,
} from "./collection-edit";

const descriptor = {
  key: ["source", "kind", "externalId"],
  primary: { key: "isPrimary", scope: ["source", "kind"] },
};
const first = {
  source: "sample",
  kind: "sku",
  externalId: "A",
  url: null,
  isPrimary: true,
};
const second = { ...first, externalId: "B", isPrimary: false };
const rowAt = (draft: CollectionDraft, index: number) => {
  const row = draft.collectionEdit.rows[index];
  if (!row) throw new Error("Missing test row");
  return row;
};
const options = { descriptor, attributes: ["url", "isPrimary"] };

describe("ordinary collection edit intent", () => {
  it("leaves an untouched baseline alone and adds without commanding its primary", () => {
    const draft = collectionDraft([first], false);
    expect(collectionWireValue(draft, options)).toEqual([]);
    draft.collectionEdit.rows.push({
      localKey: "new-row",
      baseline: null,
      value: second,
      primaryIntent: false,
      replacing: false,
    });
    expect(collectionWireValue(draft, options)).toEqual([
      {
        op: "add",
        key: { source: "sample", kind: "sku", externalId: "B" },
        value: { url: null },
      },
    ]);
  });

  it("replaces one identity atomically and preserves its baseline role and URL", () => {
    const draft = collectionDraft([first, second], false);
    rowAt(draft, 0).value = { ...first, externalId: "C" };
    expect(collectionWireValue(draft, options)).toEqual([
      {
        op: "remove",
        key: { source: "sample", kind: "sku", externalId: "A" },
        expect: { url: null, isPrimary: true },
      },
      {
        op: "add",
        key: { source: "sample", kind: "sku", externalId: "C" },
        value: { url: null, isPrimary: true },
      },
    ]);
  });

  it("normalizes equivalent keys before deciding whether identity changed", () => {
    const draft = collectionDraft([first], false);
    rowAt(draft, 0).value = { ...first, externalId: " a " };
    const normalize = (row: CollectionRow) => ({
      ...row,
      externalId: String(row.externalId).trim().toUpperCase(),
    });
    expect(collectionWireValue(draft, { ...options, normalize })).toEqual([]);
  });

  it("refuses a replacement target that already exists, preserving both identities", () => {
    const draft = collectionDraft([first, second], false);
    rowAt(draft, 0).value = second;
    expect(() => collectionWireValue(draft, options)).toThrow("already exists");
  });

  it("promotes with baseline stored expectations rather than derived read links", () => {
    const draft = collectionDraft([first, second], false);
    rowAt(draft, 1).primaryIntent = true;
    expect(collectionWireValue(draft, options)).toEqual([
      {
        op: "replace",
        key: { source: "sample", kind: "sku", externalId: "B" },
        value: { isPrimary: true },
        expect: { url: null, isPrimary: false },
      },
    ]);
  });

  it("removes by original key with expectations, leaving survivor promotion to the writer", () => {
    const draft = collectionDraft([first, second], false);
    rowAt(draft, 0).value = null;
    expect(collectionWireValue(draft, options)).toEqual([
      {
        op: "remove",
        key: { source: "sample", kind: "sku", externalId: "A" },
        expect: { url: null, isPrimary: true },
      },
    ]);
  });

  it("materializes exactly one create primary without turning it into update intent", () => {
    const draft = collectionDraft(
      [first, { ...second, isPrimary: true }],
      true,
    );
    expect(collectionWireValue(draft, options)).toEqual([first, second]);
    expect(draft.collectionEdit.rows.every((row) => !row.primaryIntent)).toBe(
      true,
    );
  });

  it("refuses an update without a saved baseline", () => {
    expect(() => collectionDraft(undefined, false)).toThrow("saved collection");
  });
});
