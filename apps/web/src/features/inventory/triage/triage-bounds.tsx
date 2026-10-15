import {
  type ProductCategoryShortcode,
  productCategoryShortcode,
} from "@cubby/schemas/identifiers";
import { useState } from "react";

import { Picker } from "~/entity/picker/picker";
import { referenceEntitySearch } from "~/entity/picker/reference-entity-search";
import { Input } from "~/ui/primitives/input";

const CategorySearch = referenceEntitySearch("productCategory");

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
        <CategorySearch>
          {({ items, ...search }) => (
            <Picker
              {...search}
              inputId="triage-category"
              label="Category"
              entity="productCategory"
              placeholder="All categories"
              clearable
              items={items}
              value={
                categoryId
                  ? (items.find((item) => item.id === categoryId) ?? {
                      id: categoryId,
                      name: categoryId,
                    })
                  : null
              }
              setValue={(item) => {
                const parsed = productCategoryShortcode.safeParse(item?.id);
                onChange({
                  minSpend,
                  categoryId: parsed.success ? parsed.data : undefined,
                });
              }}
            />
          )}
        </CategorySearch>
      </div>
    </div>
  );
}
