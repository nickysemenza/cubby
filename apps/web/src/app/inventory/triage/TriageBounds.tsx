import {
  type ProductCategoryShortcode,
  productCategoryShortcode,
} from "@cubby/schemas/identifiers";
import { useMemo, useState } from "react";

import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { treePickerItems } from "~/ui/combobox/tree-items";
import { useProductCategories } from "~/ui/hooks/useProductCategories";
import { Input } from "~/ui/primitives/input";

export interface TriageBoundsValue {
  minSpend: number | undefined;
  categoryId: ProductCategoryShortcode | undefined;
}

/**
 * Bound the pass to the rows worth walking first: a net-basis floor and/or one
 * category. Changing either re-keys the pass (see `scopeKey`), so a bounded
 * walk never resumes an unbounded one's progress.
 */
export function TriageBounds({
  minSpend,
  categoryId,
  onChange,
}: TriageBoundsValue & { onChange: (next: TriageBoundsValue) => void }) {
  const { categories } = useProductCategories();
  const categoryOptions = useMemo<PickerOption[]>(
    () => [
      { value: "", label: "All categories" },
      ...treePickerItems(categories, {
        idOf: (category) => category.id,
        parentIdOf: (category) => category.path.at(-2)?.id ?? null,
        labelOf: (category) => category.name,
      }).map((item) => ({
        value: item.id,
        label: item.name,
        group: item.presentation?.group,
        depth: item.presentation?.depth,
        rowLabel: item.presentation?.rowLabel,
      })),
    ],
    [categories],
  );
  const [draft, setDraft] = useState(minSpend?.toString() ?? "");

  const commitSpend = () => {
    const parsed = Number(draft);
    const next = draft.trim() !== "" && parsed > 0 ? parsed : undefined;
    setDraft(next?.toString() ?? "");
    if (next !== minSpend) onChange({ minSpend: next, categoryId });
  };

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <label htmlFor="triage-min-spend" className="flex items-center gap-2">
        <span className="shrink-0 eyebrow">Spent at least</span>
        <Input
          id="triage-min-spend"
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          placeholder="Any amount"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitSpend}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitSpend();
          }}
          className="w-32"
        />
      </label>
      <div className="flex items-center gap-2">
        <span className="shrink-0 eyebrow">Category</span>
        <Picker
          inputId="triage-category"
          label="Category"
          options={categoryOptions}
          value={categoryId ?? ""}
          onValueChange={(value) => {
            const parsed = productCategoryShortcode.safeParse(value);
            onChange({
              minSpend,
              categoryId: parsed.success ? parsed.data : undefined,
            });
          }}
        />
      </div>
    </div>
  );
}
