import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { z } from "zod";

import { EntityIcon, isBrowserRoutedEntity } from "~/entity/entities";
import { compileEntityListInput, entityListFor } from "~/entity/entity-list";
import { entityListHref, entityListSearch } from "~/entity/entity-list-href";
import {
  type ListEntity,
  listEntities,
} from "~/entity/generated/entity-lists.gen";
import { type ViewDefinition, viewManifest } from "~/entity/view-manifest";
import { Grid, SectionHeading } from "~/ui/layout";
import { Skeleton } from "~/ui/primitives/skeleton";

type PinnedView = {
  entity: ListEntity & BrowserRoutedEntity;
  view: ViewDefinition;
};

const isListEntity = (entity: string): entity is ListEntity =>
  listEntities.some((candidate) => candidate === entity);

/** Saved views declared `pin: { surface: "home" }`, in declared order. */
const pinnedViews: PinnedView[] = Object.entries(viewManifest)
  .flatMap(([entity, views]) =>
    isListEntity(entity) && isBrowserRoutedEntity(entity)
      ? (views ?? [])
          .filter((view) => view.pin?.surface === "home")
          .map((view) => ({ entity, view }))
      : [],
  )
  .sort((a, b) => (a.view.pin?.order ?? 0) - (b.view.pin?.order ?? 0));

const THUMBNAILS = 3;

const previewRows = z.array(
  z.looseObject({
    id: z.string(),
    displayImages: z
      .array(
        z.object({
          url: z.string(),
          representations: z.object({ preferred: z.string() }).optional(),
        }),
      )
      .optional(),
  }),
);

/**
 * The home "Your views" row: one tile per pinned saved view, opening the
 * generic list with that view's exact filters, sort, and layout. `@me` stays
 * in the URL, so each member's tile counts their own rows.
 */
export function PinnedViews() {
  const titleId = useId();
  if (pinnedViews.length === 0) return null;
  return (
    <section aria-labelledby={titleId}>
      <SectionHeading
        id={titleId}
        title={
          <>
            <PushPinIcon
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            Your views
          </>
        }
        description="Saved lists, one tap away."
      />
      <Grid className="mt-2 grid-cols-2 lg:grid-cols-4" gap="sm">
        {pinnedViews.map((pin) => (
          <PinnedViewTile key={`${pin.entity}:${pin.view.id}`} {...pin} />
        ))}
      </Grid>
    </section>
  );
}

function PinnedViewTile({ entity, view }: PinnedView) {
  const search = entityListSearch(entity, view);
  const { data, isLoading } = useQuery(
    entityListFor(entity).queryOptions(
      compileEntityListInput(entity, search, { pageSize: THUMBNAILS }),
    ),
  );
  const rows = previewRows.catch([]).parse(data?.items);
  const images = rows
    .flatMap((row) => row.displayImages?.slice(0, 1) ?? [])
    .map((image) => image.representations?.preferred ?? image.url);
  const total = data?.meta.totalCount;
  return (
    <Link
      to={entityListHref(entity, view)}
      aria-label={`${view.label}${total === undefined ? "" : `, ${total}`}`}
      className="group flex min-h-24 flex-col justify-between gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-foreground/20 hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <EntityIcon entity={entity} colored className="size-4 shrink-0" />
          <span className="truncate">{view.label}</span>
        </span>
        {isLoading ? (
          <Skeleton className="h-5 w-6" />
        ) : (
          <span className="font-mono text-sm text-muted-foreground tabular-nums">
            {total ?? "—"}
          </span>
        )}
      </div>
      <div className="flex h-10 items-end -space-x-2" aria-hidden>
        {images.map((url, index) => (
          <img
            key={url}
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-10 rounded-md bg-muted object-contain ring-2 ring-card"
            style={{ zIndex: THUMBNAILS - index }}
          />
        ))}
      </div>
    </Link>
  );
}
