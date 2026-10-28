import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { homePinnedViews } from "@cubby/schemas/entity-roster";
import { useQueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { EntityIcon, isBrowserRoutedEntity } from "~/entity/entities";
import { compileEntityListInput, entityListFor } from "~/entity/entity-list";
import { entityListHref, entityListSearch } from "~/entity/entity-list-href";
import {
  type ListEntity,
  listEntities,
} from "~/entity/generated/entity-lists.gen";
import { useEntityMetadata } from "~/entity/metadata";
import {
  type ViewDefinition,
  toViewDefinition,
} from "~/entity/model/view-manifest";
import { formatCount } from "~/lib/number-format";
import { QuerySection } from "~/ui/feedback/query-section";
import { Section } from "~/ui/layout";
import { Skeleton } from "~/ui/primitives/skeleton";

import { HomeList, HomeRow } from "./home-list";

type PinnedView = {
  entity: ListEntity & BrowserRoutedEntity;
  view: ViewDefinition;
};

const isListEntity = (entity: string): entity is ListEntity =>
  listEntities.some((candidate) => candidate === entity);

/** Saved views declared `pin: { surface: "home" }`, in declared order. */
const pinnedViews: PinnedView[] = homePinnedViews
  .flatMap(({ entity, view }) =>
    isListEntity(entity) && isBrowserRoutedEntity(entity)
      ? [{ entity, view: toViewDefinition(view) }]
      : [],
  )
  .sort((a, b) => (a.view.pin?.order ?? 0) - (b.view.pin?.order ?? 0));

/**
 * Home's "Your views" rail: one row per pinned saved view, opening the generic
 * list with that view's exact filters, sort, and layout. `@me` stays in the
 * URL, so each member's row counts their own records.
 */
export function PinnedViews() {
  if (pinnedViews.length === 0) return null;
  return (
    <Section title="Your views" headingAs="h2" ruled>
      <HomeList label="Your views">
        {pinnedViews.map((pin) => (
          <QuerySection
            key={`${pin.entity}:${pin.view.id}`}
            title={pin.view.label}
            fallback={
              <HomeRow>
                <Skeleton className="h-4 w-24" />
              </HomeRow>
            }
          >
            <PinnedViewRow {...pin} />
          </QuerySection>
        ))}
      </HomeList>
    </Section>
  );
}

function PinnedViewRow({ entity, view }: PinnedView) {
  const queryClient = useQueryClient();
  useEntityMetadata(entity);
  const search = entityListSearch(queryClient, entity, view);
  const { data, isLoading } = useQuery(
    entityListFor(entity).queryOptions(
      compileEntityListInput(queryClient, entity, search, {
        pageSize: 1,
        includeCount: true,
      }),
    ),
  );
  const total = data?.meta.totalCount;
  return (
    <HomeRow
      trailing={
        isLoading ? (
          <Skeleton className="h-4 w-6" />
        ) : (
          <span className="font-mono text-xs text-muted-foreground">
            {total === undefined ? "—" : formatCount(total)}
          </span>
        )
      }
    >
      <EntityIcon
        entity={entity}
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <Link
        to={entityListHref(queryClient, entity, view)}
        aria-label={`${view.label}${total === undefined ? "" : `, ${total}`}`}
        className="truncate underline-offset-2 outline-none hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        {view.label}
      </Link>
    </HomeRow>
  );
}
