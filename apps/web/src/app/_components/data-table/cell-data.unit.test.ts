import type { Amount } from "@cubby/schemas/codec";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  amountCellData,
  booleanCellData,
  dateCellData,
  entityCellData,
} from "./cell-data";

interface Row {
  id: string;
  relation: { id: string; name: string } | null;
}

const filled: Row = { id: "row-1", relation: { id: "rel-1", name: "One" } };

describe("entityCellData clear capability", () => {
  it("does not expose clearing for a required relation", () => {
    const data = entityCellData<Row, string>(
      "location",
      (value) => z.string().parse(value),
      (row) => row.relation,
      async () => {},
    );
    expect(data.applyClear).toBeUndefined();
  });

  it("exposes clearing only when the nullable adapter supplies it", async () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    const data = entityCellData<Row, string>(
      "location",
      (value) => z.string().parse(value),
      (row) => row.relation,
      async () => {},
      clear,
    );
    await expect(data.applyClear?.(filled)).resolves.toBeNull();
    expect(clear).toHaveBeenCalledWith(filled);
  });
});

describe("dateCellData", () => {
  it("normalizes natural-language clipboard text before saving", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 18, 9, 30));
    const save = vi.fn().mockResolvedValue(undefined);
    const data = dateCellData<null>(() => null, save);

    try {
      await expect(
        data.applyPaste?.(null, { text: "next Friday" }),
      ).resolves.toBe("2026-08-28");
      expect(save).toHaveBeenCalledWith(null, "2026-08-28");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid clipboard text without saving", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const data = dateCellData<null>(() => null, save);

    await expect(
      data.applyPaste?.(null, { text: "not a date" }),
    ).rejects.toThrow("Couldn’t understand that date");
    expect(save).not.toHaveBeenCalled();
  });
});

describe("booleanCellData", () => {
  it.each([
    ["true", true],
    ["yes", true],
    ["1", true],
    ["false", false],
    ["no", false],
    ["0", false],
  ] as const)("accepts spreadsheet boolean %s", async (text, expected) => {
    const save = vi.fn().mockResolvedValue(undefined);
    const data = booleanCellData<null>(() => null, save);

    await expect(data.applyPaste?.(null, { text })).resolves.toBe(expected);
    expect(save).toHaveBeenCalledWith(null, expected);
  });

  it("rejects an unrecognised boolean without saving", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const data = booleanCellData<null>(() => null, save);

    await expect(data.applyPaste?.(null, { text: "perhaps" })).rejects.toThrow(
      "Pasted value is not a boolean",
    );
    expect(save).not.toHaveBeenCalled();
  });
});

describe("amountCellData", () => {
  const build = (stored: Amount = { value: 1, unit: "g" }) => {
    const save = vi.fn<(row: null, amount: Amount) => Promise<void>>(
      async () => {},
    );
    return { save, data: amountCellData<null>(() => stored, save) };
  };

  const pasteText = async (text: string): Promise<Amount> => {
    const { save, data } = build();
    await data.applyPaste?.(null, { text });
    const saved = save.mock.calls[0]?.[1];
    if (!saved) throw new Error("nothing saved");
    return saved;
  };

  // The regression table. Every row here was persisted WRONG by the hand-rolled
  // /^(-?\d+(?:\.\d+)?)\s*(.*)$/ fallback this replaces — see the `was` column.
  // Parsing is the Rust grammar's job (`wasm.parse_amount`); a TS regex can't do
  // mixed numbers, and the units it invented ("1/2 cups", ",5 kg", "") reach no
  // edge in the unit graph, so costing/valuation downstream went blank or wrong.
  const CASES: { text: string; want: Amount; was: string }[] = [
    {
      text: "1 1/2 cups",
      want: { value: 1.5, unit: "cup" },
      was: "1 / '1/2 cups'",
    },
    // The grammar stops at the decimal comma, so this stays a misread — but it
    // must NOT be "rescued" into {1, "kg"}, which reads as deliberate. `whole`
    // keeps the anomaly visible. See preserveWrittenWholeUnit.
    { text: "1,5 kg", want: { value: 1, unit: "whole" }, was: "1 / ',5 kg'" },
    {
      text: "2.5 lb",
      want: { value: 2.5, unit: "lb" },
      was: "2.5 / 'lb' (ok)",
    },
    { text: "5 each", want: { value: 5, unit: "each" }, was: "5 / 'each'" },
    // Regression: trailing punctuation used to defeat the
    // `/([a-z]+)$/` anchor in preserveWrittenWholeUnit, so a spreadsheet cell
    // ending in a period fell back to the bare "whole" spelling instead of
    // keeping "each".
    {
      text: "5 each.",
      want: { value: 5, unit: "each" },
      was: "5 / 'whole' (trailing '.' broke the word match)",
    },
    { text: "3", want: { value: 3, unit: "whole" }, was: "3 / '' (invalid)" },
  ];

  // The alias-vs-real-unit split that makes the above safe: a word the grammar
  // resolves to a genuine unit is never re-attached, so a parse that lost the
  // unit stays visibly wrong rather than plausibly wrong.
  it.each([
    ["7 ea", { value: 7, unit: "ea" }],
    ["7 pcs", { value: 7, unit: "pcs" }],
    ["7 units", { value: 7, unit: "units" }],
    ["7 cans", { value: 7, unit: "can" }],
  ] as const)("keeps the written whole-alias in %s", async (text, want) => {
    expect(await pasteText(text)).toEqual(want);
  });

  for (const { text, want, was } of CASES) {
    it(`parses ${JSON.stringify(text)} through the engine (regex gave ${was})`, async () => {
      expect(await pasteText(text)).toEqual(want);
    });
  }

  it("carries a pasted range into upperValue", async () => {
    expect(await pasteText("2-3 cups")).toEqual({
      value: 2,
      unit: "cup",
      upperValue: 3,
    });
  });

  it("throws instead of saving when the text is not an amount", async () => {
    const { save, data } = build();
    await expect(
      data.applyPaste?.(null, { text: "not an amount" }),
    ).rejects.toThrow("not an amount");
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    [{ value: 5, unit: "each" }],
    [{ value: 7, unit: "ea" }],
    [{ value: 1, unit: "can" }],
    [{ value: 1.5, unit: "cup" }],
    [{ value: 2.5, unit: "lb" }],
    [{ value: 3, unit: "whole" }],
  ] as const)("survives a text copy→paste round-trip: %j", async (stored) => {
    const { data } = build(fromPartial<Amount>(stored));
    const text = data.getCopyPayload(null)?.text;
    expect(text).toBeTruthy();
    if (!text) return;
    expect(await pasteText(text)).toEqual(stored);
  });

  it("prefers the typed payload over the text, range included", async () => {
    const { save, data } = build();
    await data.applyPaste?.(null, {
      json: { value: 2, unit: "cup", upperValue: 3 },
      text: "ignored",
    });
    expect(save.mock.calls[0]?.[1]).toEqual({
      value: 2,
      unit: "cup",
      upperValue: 3,
    });
  });

  it("copies via the canonical formatter, so text round-trips", async () => {
    const { data } = build({ value: 1.5, unit: "cup" });
    const payload = data.getCopyPayload(null);
    expect(payload?.text).toBe("1½ cups");
    expect(await pasteText(payload?.text ?? "")).toEqual({
      value: 1.5,
      unit: "cup",
    });
  });

  it("copies a stored range and pastes it back unchanged", async () => {
    const stored: Amount = { value: 2, unit: "cup", upperValue: 3 };
    const { data } = build(stored);
    const payload = data.getCopyPayload(null);
    expect(payload?.json).toEqual(stored);
    expect(await pasteText(payload?.text ?? "")).toEqual(stored);
  });
});
