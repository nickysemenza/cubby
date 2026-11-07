import type { Entity } from "@cubby/schemas/entity";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { entityLabel } from "~/entity/entities";
import {
  pagination,
  pickerLexicalQueryOptions,
  pickerQueryState,
} from "~/entity/picker/entity-search-hooks";
import { Picker } from "~/ui/combobox/picker";

/** Uses the canonical lexical search rather than downloading entity lists. */
export function EntityGraphPicker({
  onSelect,
  label = "Starting record",
  placeholder = "Find a cookbook, recipe, product, or another record…",
}: {
  onSelect: (root: { entity: Entity; id: string }) => void;
  label?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const [query] = useDebouncedValue(draft, { wait: 200 });
  const results = useInfiniteQuery({
    ...pickerLexicalQueryOptions({
      query: query.trim() || "inactive-search",
      limit: pagination.pageSize,
    }),
    enabled: query.trim().length > 0,
  });
  const items = useMemo(
    () =>
      (results.data?.items ?? []).map((hit) => ({
        id: hit.id,
        name: hit.title,
        secondary: entityLabel(hit.entityKind),
        detail: hit.subtitle ?? undefined,
      })),
    [results.data],
  );
  return (
    <Picker
      label={label}
      placeholder={placeholder}
      items={items}
      value={null}
      onSearchChange={setDraft}
      {...pickerQueryState(results)}
      setValue={(item) => {
        const hit = results.data?.items.find(
          (result) => result.id === item?.id,
        );
        if (hit) onSelect({ entity: hit.entityKind, id: hit.id });
      }}
    />
  );
}
