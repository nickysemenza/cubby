/**
 * Column-level cell data (copy/paste) — one source of truth for how a column's
 * value is copied and how a pasted value is applied.
 *
 * Each editable/copyable column carries a row-parametrized `ColumnCellData` in
 * its `meta.cellData` (wired by the factories in `columnHelpers.tsx`). It's
 * consumed both by the single-cell clipboard (via `specFromCellData`, below)
 * and by the range copy/paste engine, which must operate against the full
 * TanStack row model — including virtualized off-screen rows it only has the
 * row for, not a rendered cell.
 *
 * Kinds are BASE types ("text" | "number" | "currency" | "date" | "select" |
 * "amount" | "entity:<name>"): paste is allowed between any two columns of the
 * same base kind (e.g. one text column into another), not scoped per-column.
 * Builders throw on invalid pastes — the clipboard surfaces the message as a
 * toast — and resolve with the saved value for the cell's optimistic display.
 *
 * Logic-only module (no React components of its own). Amount values reach the
 * WASM boundary via `tryFormatAmount` for canonical rendering and
 * `wasm.parse_amount` for reading amount text back. Date values similarly use
 * the shared plain-date parser instead of inventing a clipboard-only grammar.
 * Amount formatting and parsing belong to the Rust engine; a TS
 * reimplementation of either is what this module used to have, and it
 * corrupted saved data.
 */

import { amount as amountSchema, type Amount } from "@cubby/schemas/codec";
import type { CellData } from "@tanstack/react-table";
import { z } from "zod";

import { parsePlainDateInput } from "~/lib/plain-date-input";
import { wasm } from "~/lib/wasm";

import type { ComboboxItem } from "../combobox/combobox-types";
import { tryFormatAmount } from "../inventory/format-amount";
import type {
  CellClipboardSpec,
  CellCopyPayload,
  CellJsonValue,
  CellPastePayload,
} from "./cell-clipboard";
import type { CellKind } from "./cell-clipboard-model";
import type { FilterableComboboxItem } from "./editable-cell";

/**
 * Column-level copy/paste descriptor. `getCopyPayload` / `applyPaste` take the
 * row (not a value captured from a single rendered cell) so the range engine
 * can copy/paste against the whole row model, virtualized rows included.
 */
export interface ColumnCellData<
  TData = CellData,
  TSaved = CellJsonValue | null | void,
> {
  kind: CellKind;
  /**
   * Typed numeric projection for read-only selection statistics. This is
   * deliberately separate from clipboard text: formatted currency, localized
   * numbers, and empty display states must never be parsed back out of the DOM.
   */
  getNumericValue?: (row: TData) => number | null;
  /** null → nothing to copy (empty TSV field). */
  getCopyPayload: (row: TData) => CellCopyPayload | null;
  /** Absent → column is read-only for paste. Resolves with the saved value (for optimistic display). */
  applyPaste?: (row: TData, payload: CellPastePayload) => Promise<TSaved>;
  /** Absent unless this specific relation is nullable. */
  applyClear?: (row: TData) => Promise<TSaved>;
}

const pastedStringSchema = z.string();
const pastedNumberSchema = z.number();
const pastedEntitySchema = z.object({ id: z.string(), name: z.string() });
const pastedTagsSchema = z.array(z.string());
const pastedBooleanSchema = z.boolean();

const pastedString = (payload: CellPastePayload): string => {
  const parsed = pastedStringSchema.safeParse(payload.json);
  return parsed.success ? parsed.data : (payload.text ?? "");
};

/**
 * Adapt a column's `ColumnCellData` + a specific row into a per-cell
 * `CellClipboardSpec` for the single-cell clipboard registry (detail-page and
 * in-table editable cells). The kind key is the base kind; copy/paste delegate
 * to the column's row-parametrized builders, so select validation, amount
 * parsing, etc. live in exactly one place (and the range engine, which calls
 * `applyPaste` directly, gets the same validation for free).
 */
export function specFromCellData<TData, TSaved>(
  cellData: ColumnCellData<TData, TSaved>,
  row: TData,
): CellClipboardSpec<TSaved> {
  const { kind, getCopyPayload, applyPaste } = cellData;
  return {
    kindKey: kind,
    getCopyPayload: () => getCopyPayload(row),
    onPasteValue: applyPaste
      ? (payload) => applyPaste(row, payload)
      : undefined,
  };
}

export function textCellData<TData>(
  kind: CellKind,
  getValue: (row: TData) => string | null,
  save?: (row: TData, value: string | null) => Promise<void>,
): ColumnCellData<TData, string | null> {
  return {
    kind,
    getCopyPayload: (row) => {
      const value = getValue(row);
      return value == null || value === ""
        ? null
        : { text: value, json: value };
    },
    applyPaste: save
      ? async (row, { json, text }) => {
          const raw = pastedString({ json, text });
          const next = raw.trim() === "" ? null : raw.trim();
          await save(row, next);
          return next;
        }
      : undefined,
  };
}

export function dateCellData<TData>(
  getValue: (row: TData) => string | null,
  save?: (row: TData, value: string | null) => Promise<void>,
): ColumnCellData<TData, string | null> {
  return {
    kind: "date",
    getCopyPayload: (row) => {
      const value = getValue(row);
      return value == null || value === ""
        ? null
        : { text: value, json: value };
    },
    applyPaste: save
      ? async (row, { json, text }) => {
          const raw = pastedString({ json, text });
          const parsed = parsePlainDateInput(raw);
          if (!parsed.ok) throw new Error(parsed.error);
          await save(row, parsed.value);
          return parsed.value;
        }
      : undefined,
  };
}

/** Boolean cells keep a typed payload in-app and accept the familiar text
 * spellings when pasted from a spreadsheet. */
export function booleanCellData<TData>(
  getValue: (row: TData) => boolean | null,
  save?: (row: TData, value: boolean) => Promise<void>,
): ColumnCellData<TData, boolean | null> {
  return {
    kind: "boolean",
    getCopyPayload: (row) => {
      const value = getValue(row);
      return value == null ? null : { text: String(value), json: value };
    },
    applyPaste: save
      ? async (row, { json, text }) => {
          const typed = pastedBooleanSchema.safeParse(json);
          const normalized = (text ?? "").trim().toLowerCase();
          const value = typed.success
            ? typed.data
            : normalized === "true" ||
                normalized === "yes" ||
                normalized === "1"
              ? true
              : normalized === "false" ||
                  normalized === "no" ||
                  normalized === "0"
                ? false
                : null;
          if (value === null) throw new Error("Pasted value is not a boolean");
          await save(row, value);
          return value;
        }
      : undefined,
  };
}

export function numberCellData<TData>(
  kind: "number" | "currency",
  getValue: (row: TData) => number | null,
  save?: (row: TData, value: number | null) => Promise<void>,
): ColumnCellData<TData, number | null> {
  return {
    kind,
    getNumericValue: getValue,
    getCopyPayload: (row) => {
      const value = getValue(row);
      return value == null ? null : { text: String(value), json: value };
    },
    applyPaste: save
      ? async (row, { json, text }) => {
          const parsedNumber = pastedNumberSchema.safeParse(json);
          const num = parsedNumber.success
            ? parsedNumber.data
            : Number.parseFloat((text ?? "").replace(/[^0-9.-]/g, ""));
          if (Number.isNaN(num)) {
            throw new Error("Pasted value is not a number");
          }
          await save(row, num);
          return num;
        }
      : undefined,
  };
}

export function selectCellData<TData>(
  getValue: (row: TData) => string | null,
  selectOptions: FilterableComboboxItem[],
  save?: (row: TData, value: string) => Promise<void>,
): ColumnCellData<TData, string | null> {
  return {
    kind: "select",
    getCopyPayload: (row) => {
      const value = getValue(row);
      if (value == null || value === "") return null;
      const opt = selectOptions.find((o) => o.value === value);
      return { text: opt?.label ?? value, json: value };
    },
    applyPaste: save
      ? async (row, { json, text }) => {
          const candidate = pastedString({ json, text }).trim();
          const opt =
            selectOptions.find((o) => o.value === candidate) ??
            selectOptions.find(
              (o) => o.label.toLowerCase() === candidate.toLowerCase(),
            );
          if (!opt || opt.value === "") {
            throw new Error(`"${candidate}" is not a valid option here`);
          }
          await save(row, opt.value);
          return opt.value;
        }
      : undefined,
  };
}

/**
 * Entity-picker cell data. `entity:<name>` kinds deliberately paste across
 * tables (a location copied on the Locations page pastes into any location
 * cell). Text paste is rejected — id resolution by name would be guesswork;
 * server-side validation still applies to the pasted id.
 */
export function entityCellData<TData, TId extends string>(
  entity: string,
  parseId: (value: string) => TId,
  getItem: (row: TData) => ComboboxItem<TId> | null,
  save?: (row: TData, id: TId) => Promise<void>,
  clear?: (row: TData) => Promise<void>,
): ColumnCellData<TData, Pick<ComboboxItem<TId>, "id" | "name"> | null> {
  return {
    kind: `entity:${entity}`,
    getCopyPayload: (row) => {
      const item = getItem(row);
      return item
        ? { text: item.name, json: { id: item.id, name: item.name } }
        : null;
    },
    applyPaste: save
      ? async (row, { json }) => {
          const parsed = pastedEntitySchema.safeParse(json);
          if (!parsed.success) {
            throw new Error(`Paste a ${entity} cell here`);
          }
          const pasted = {
            id: parseId(parsed.data.id),
            name: parsed.data.name,
          };
          await save(row, pasted.id);
          return { id: pasted.id, name: pasted.name };
        }
      : undefined,
    applyClear: clear
      ? async (row) => {
          await clear(row);
          return null;
        }
      : undefined,
  };
}

/**
 * Amount cell data. BOTH directions go through the engine: copy renders with the
 * canonical formatter (`tryFormatAmount` → `wasm.format_amount`) and a plain-text
 * paste is read back by `wasm.parse_amount`, so a copy→paste round-trip through a
 * spreadsheet is lossless instead of degrading.
 *
 * Neither side may be hand-rolled in TS. The `${value} ${unit}` template this
 * replaces emitted a non-canonical string, and the regex fallback
 * (`^(-?\d+(?:\.\d+)?)\s*(.*)$`) that read text back misparsed anything the
 * measurement grammar actually handles — and then SAVED the result:
 * `"1 1/2 cups"` became `{value: 1, unit: "1/2 cups"}` (a 33% understatement plus
 * a unit no unit-graph edge can reach, so downstream costing/valuation goes blank
 * or wrong) and `"1,5 kg"` became `{value: 1, unit: ",5 kg"}`.
 */
export function amountCellData<TData>(
  getAmount: (row: TData) => Amount,
  save: (row: TData, amount: Amount) => Promise<void>,
): ColumnCellData<TData, Amount> {
  return {
    kind: "amount",
    getCopyPayload: (row) => {
      const amount = getAmount(row);
      const json: z.input<typeof amountSchema> = {
        value: amount.value,
        unit: amount.unit,
      };
      if (amount.upperValue != null) json.upperValue = amount.upperValue;
      return {
        text: tryFormatAmount(amount),
        // The typed payload is the exact stored amount (range included), so an
        // in-app cell→cell paste never round-trips through the text at all.
        json,
      };
    },
    applyPaste: async (row, { json, text }) => {
      const typed = amountSchema.safeParse(json);
      if (typed.success) {
        await save(row, typed.data);
        return typed.data;
      }
      // No typed payload — free text ("1 1/2 cups", "2.5 lb", "5 each", "3",
      // "2-3 cups"). The grammar owns mixed numbers, vulgar fractions, ranges,
      // and unit normalization; it throws on text carrying no measurement, which
      // is the only correct answer for a paste that isn't an amount.
      let parsed: { value: number; unit: string; upper_value?: number };
      try {
        parsed = wasm.parse_amount(text ?? "");
      } catch {
        throw new Error("Pasted value is not an amount");
      }
      const next: Amount = {
        value: parsed.value,
        unit: preserveWrittenWholeUnit(text, parsed.unit),
      };
      if (parsed.upper_value != null) next.upperValue = parsed.upper_value;
      await save(row, next);
      return next;
    },
  };
}

/**
 * The grammar keeps arbitrary count nouns as written (`1 can` → `can`,
 * `4 bags` → `bag`) but folds `each`/`ea`/`pcs`/`units` onto their canonical
 * spelling `whole` — all the same `Unit::Whole` node in the conversion graph.
 * The fold is invisible to costing and valuation, and very visible in a table:
 * essentially every inventory row is denominated in "each", so pasting
 * `5 each` and getting `5 whole` back would leave one row spelled differently
 * from all its neighbours for no reason the user can see.
 *
 * Preserving the written word needs care, because `whole` is also what the
 * grammar falls back to when it *fails* to reach the unit. `1,5 kg` stops at
 * the comma and yields `{1, whole}`; blindly keeping the trailing word would
 * store `{1, "kg"}` — still wrong by a third, but now plausible enough to go
 * unnoticed, which is worse than an obviously-bogus `whole`.
 *
 * So the word only survives if the engine itself confirms it is a `whole`
 * alias when parsed on its own. `each` → `whole` (keep it); `kg` → `kg`, so
 * the grammar did know that word and our parse genuinely lost information —
 * leave the anomaly visible. This self-maintains: a new alias upstream is
 * honoured with no list to update here.
 */
function preserveWrittenWholeUnit(
  text: string | undefined,
  parsedUnit: string,
): string {
  if (parsedUnit !== "whole") return parsedUnit;
  // Trailing punctuation (`5 each.`, `5 each!`) shouldn't defeat the match —
  // anchor on the last run of letters, tolerating punctuation after it.
  const written = (text ?? "")
    .trim()
    .match(/([a-z]+)[.,!?;:]*$/i)?.[1]
    ?.toLowerCase();
  if (!written || !isWholeAlias(written)) return parsedUnit;
  return written;
}

/** Does the grammar fold this word onto `whole` when parsed on its own? */
function isWholeAlias(word: string): boolean {
  try {
    return wasm.parse_amount(`1 ${word}`).unit === "whole";
  } catch {
    return false;
  }
}

/**
 * Tags cell data (recipe tags, a `string[] | null` column). Copy joins the tags
 * as a comma-separated string for the system clipboard and carries the raw
 * array as the typed payload. Paste prefers the typed array; a text paste
 * splits on commas, trims, lowercases (matching `TagInput`'s normalization),
 * and drops empties. An empty result clears the column (saves `null`). Resolves
 * with the saved value (`string[] | null`) for the cell's optimistic display.
 */
export function tagsCellData<TData>(
  getTags: (row: TData) => string[] | null,
  save?: (row: TData, tags: string[] | null) => Promise<void>,
): ColumnCellData<TData, string[] | null> {
  return {
    kind: "tags",
    getCopyPayload: (row) => {
      const tags = getTags(row);
      return tags == null || tags.length === 0
        ? null
        : { text: tags.join(", "), json: [...tags] };
    },
    applyPaste: save
      ? async (row, { json, text }) => {
          const parsedTags = pastedTagsSchema.safeParse(json);
          const fromJson = parsedTags.success ? parsedTags.data : undefined;
          const next =
            fromJson ??
            (text ?? "")
              .split(",")
              .map((t) => t.trim().toLowerCase())
              .filter((t) => t !== "");
          const value = next.length === 0 ? null : next;
          await save(row, value);
          return value;
        }
      : undefined,
  };
}

/**
 * Copy-only cell data for timestamp columns: the display is relative
 * ("5 months ago") but the copy payload is the ISO date-time so it pastes
 * cleanly into a spreadsheet. No `applyPaste` — timestamps aren't user-editable.
 */
export function timestampCellData<TData>(
  getValue: (row: TData) => string | Date | null | undefined,
): ColumnCellData<TData> {
  return textCellData<TData>("text", (row) => {
    const v = getValue(row);
    if (!v) return null;
    return v instanceof Date ? v.toISOString() : v;
  });
}
