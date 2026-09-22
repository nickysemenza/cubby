import type { Entity } from "@cubby/schemas/entity";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { entityLabel } from "~/entities/entities";
import { getAppErrorDetails } from "~/lib/error-utils";
import { search } from "~/lib/search.functions";

import { EntityPicker } from "../combobox/entity-picker";

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
  const results = useQuery({
    ...search.find.queryOptions({
      query: query.trim() || "inactive-search",
      limit: 20,
    }),
    enabled: query.trim().length > 0,
  });
  const items = useMemo(
    () =>
      (results.data ?? []).map((hit) => ({
        id: hit.id,
        name: hit.title,
        secondary: entityLabel(hit.entityType),
        detail: hit.subtitle ?? undefined,
      })),
    [results.data],
  );
  return (
    <EntityPicker
      label={label}
      placeholder={placeholder}
      items={items}
      value={null}
      onSearchChange={setDraft}
      isLoading={results.isFetching}
      error={results.isError ? getAppErrorDetails(results.error).message : null}
      setValue={(item) => {
        const hit = results.data?.find((result) => result.id === item?.id);
        if (hit) onSelect({ entity: hit.entityType, id: hit.id });
      }}
    />
  );
}
