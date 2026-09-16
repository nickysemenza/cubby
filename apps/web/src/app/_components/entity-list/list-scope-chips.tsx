import type { Entity } from "@cubby/schemas/entity";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { ScopeChip } from "~/app/_components/data-table/ScopeChip";
import { Row } from "~/components/layout";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { type FilterSpec, getEntityFilters } from "~/entities/filter-manifest";
import { filterUrlKey } from "~/entities/filters";
import {
  type DetailEntity,
  detailEntities,
} from "~/entities/generated/entity-details.gen";

import type { ListSearch } from "./list-slot-types";

const recordTitle = z.string().nullish().catch(null);
const scopeValue = z.string().min(1).optional().catch(undefined);

/** The entity a shortcode's prefix names, when it is one that has a detail read. */
function shortcodeEntity(value: string): DetailEntity | undefined {
  const prefix = value.slice(0, value.indexOf("-") + 1);
  if (!prefix) return undefined;
  return detailEntities.find(
    (entity) => entityManifest[entity].shortcodePrefix === prefix,
  );
}

/** "Filter by product id..." → "Product". */
function scopeLabel(spec: FilterSpec): string {
  if (spec.label) return spec.label;
  const bare = spec.placeholder
    .replace(/^(Filter|Search)( by)?( related)?\s*/iu, "")
    .replace(/\s*(id|presence)?\.\.\.$/iu, "")
    .trim();
  return bare ? bare.slice(0, 1).toUpperCase() + bare.slice(1) : spec.columnId;
}

function ResolvedScopeChip({
  label,
  value,
  onClear,
}: {
  label: string;
  value: string;
  onClear: () => void;
}) {
  const target = shortcodeEntity(value);
  const invalid = value === UNRESOLVABLE_ENTITY_FILTER;
  // Disabled (never executed) when the value names no detail entity; the
  // options are only built, and a detail read validates on execution.
  const query = useQuery({
    ...entityDetailFor(target ?? "product").queryOptions(value),
    enabled: target !== undefined && !invalid,
  });
  const title =
    target && query.data
      ? recordTitle.parse(
          z.looseObject({}).parse(query.data)[entitySummary[target].titleField],
        )
      : null;
  // A resolvable id shows nothing until its name arrives, never the raw code.
  if (target && !invalid && !query.data) return null;
  return <ScopeChip name={label} value={title ?? value} onClear={onClear} />;
}

/**
 * The visible surface of every URL-only filter — an id scope arriving from a
 * detail page's "see all" link, a text scope with no column of its own.
 * Without this such a filter would be active but invisible, with Reset as
 * the only way out. Ids resolve to the record's name through the same
 * detail read every other id→name lookup uses.
 */
export function ListScopeChips({
  entity,
  search,
  onClear,
}: {
  entity: Entity;
  search: ListSearch;
  onClear: (urlKey: string) => void;
}) {
  const active = getEntityFilters(entity).flatMap((spec) => {
    if (!spec.urlOnly) return [];
    const value = scopeValue.parse(search[filterUrlKey(spec)]);
    return value === undefined ? [] : [{ spec, value }];
  });
  if (active.length === 0) return null;
  return (
    <Row align="center" gap="xs" wrap>
      {active.map(({ spec, value }) => {
        const urlKey = filterUrlKey(spec);
        const label = scopeLabel(spec);
        if (spec.kind === "id" || spec.kind === "idMulti") {
          return (
            <ResolvedScopeChip
              key={urlKey}
              label={label}
              value={value}
              onClear={() => onClear(urlKey)}
            />
          );
        }
        return (
          <ScopeChip
            key={urlKey}
            name={label}
            value={value}
            onClear={() => onClear(urlKey)}
          />
        );
      })}
    </Row>
  );
}
