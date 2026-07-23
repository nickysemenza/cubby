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
 * Pure module: no React and no `~/` imports (only type-only imports, which are
 * erased), so it's importable from vitest unit tests per repo convention.
 */

import type { Amount } from "@cubby/schemas/codec";
import type { ComboboxItem } from "../combobox/combobox-types";
import type { CellClipboardSpec } from "./cell-clipboard";
import type { CellKind } from "./cell-range";
import type { FilterableComboboxItem } from "./editable-cell";

/**
 * Column-level copy/paste descriptor. `getCopyPayload` / `applyPaste` take the
 * row (not a value captured from a single rendered cell) so the range engine
 * can copy/paste against the whole row model, virtualized rows included.
 */
export interface ColumnCellData<TData> {
  kind: CellKind;
  /** null → nothing to copy (empty TSV field). */
  getCopyPayload: (row: TData) => { text: string; json: unknown } | null;
  /** Absent → column is read-only for paste. Resolves with the saved value (for optimistic display). */
  applyPaste?: (
    row: TData,
    payload: { json?: unknown; text?: string },
  ) => Promise<unknown>;
  /** kind "select" only: target-side validation options. */
  selectOptions?: FilterableComboboxItem[];
}

/**
 * Adapt a column's `ColumnCellData` + a specific row into a per-cell
 * `CellClipboardSpec` for the single-cell clipboard registry (detail-page and
 * in-table editable cells). The kind key is the base kind; copy/paste delegate
 * to the column's row-parametrized builders, so select validation, amount
 * parsing, etc. live in exactly one place (and the range engine, which calls
 * `applyPaste` directly, gets the same validation for free).
 */
export function specFromCellData<TData>(
  cellData: ColumnCellData<TData>,
  row: TData,
): CellClipboardSpec {
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
): ColumnCellData<TData> {
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
          const raw = typeof json === "string" ? json : (text ?? "");
          const next = raw.trim() === "" ? null : raw.trim();
          await save(row, next);
          return next;
        }
      : undefined,
  };
}

export function numberCellData<TData>(
  kind: "number" | "currency",
  getValue: (row: TData) => number | null,
  save?: (row: TData, value: number | null) => Promise<void>,
): ColumnCellData<TData> {
  return {
    kind,
    getCopyPayload: (row) => {
      const value = getValue(row);
      return value == null ? null : { text: String(value), json: value };
    },
    applyPaste: save
      ? async (row, { json, text }) => {
          const num =
            typeof json === "number"
              ? json
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
): ColumnCellData<TData> {
  return {
    kind: "select",
    selectOptions,
    getCopyPayload: (row) => {
      const value = getValue(row);
      if (value == null || value === "") return null;
      const opt = selectOptions.find((o) => o.value === value);
      return { text: opt?.label ?? value, json: value };
    },
    applyPaste: save
      ? async (row, { json, text }) => {
          const candidate =
            typeof json === "string" ? json : (text ?? "").trim();
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
export function entityCellData<TData>(
  entity: string,
  getItem: (row: TData) => ComboboxItem | null,
  save?: (row: TData, id: string) => Promise<void>,
): ColumnCellData<TData> {
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
          const pasted = json as { id?: unknown; name?: unknown } | undefined;
          if (
            !pasted ||
            typeof pasted.id !== "string" ||
            typeof pasted.name !== "string"
          ) {
            throw new Error(`Paste a ${entity} cell here`);
          }
          await save(row, pasted.id);
          return { id: pasted.id, name: pasted.name };
        }
      : undefined,
  };
}

export function amountCellData<TData>(
  getAmount: (row: TData) => Amount,
  save: (row: TData, amount: Amount) => Promise<void>,
): ColumnCellData<TData> {
  return {
    kind: "amount",
    getCopyPayload: (row) => {
      const amount = getAmount(row);
      return {
        text: `${amount.value} ${amount.unit}`.trim(),
        json: { value: amount.value, unit: amount.unit },
      };
    },
    applyPaste: async (row, { json, text }) => {
      const typed = json as { value?: unknown; unit?: unknown } | undefined;
      if (typed && typeof typed.value === "number") {
        const next: Amount = {
          value: typed.value,
          unit: typeof typed.unit === "string" ? typed.unit : "",
        };
        await save(row, next);
        return next;
      }
      // Text like "5 each" / "2.5 lb" / bare "3".
      const match = (text ?? "").trim().match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/);
      const parsedValue = match?.[1] ? Number.parseFloat(match[1]) : Number.NaN;
      if (!match || Number.isNaN(parsedValue)) {
        throw new Error("Pasted value is not an amount");
      }
      const next: Amount = {
        value: parsedValue,
        unit: (match[2] ?? "").trim(),
      };
      await save(row, next);
      return next;
    },
  };
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
): ColumnCellData<TData> {
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
          const fromJson =
            Array.isArray(json) && json.every((t) => typeof t === "string")
              ? (json as string[])
              : undefined;
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
    return typeof v === "string" ? v : v.toISOString();
  });
}
