import type { SearchDestination } from "@cubby/schemas/search";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { Suspense } from "react";

import { entitySearchFacts } from "~/entity/display/entity-display";
import { entities } from "~/entity/entities";
import { useEntityMetadata } from "~/entity/metadata";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";
import { DenseCellContext } from "~/ui/values/stacked-value";

const denseSearchCell = { linksTo: null };

function LoadedSearchFacts({ item }: { item: SearchDestination }) {
  const queryClient = useQueryClient();
  useEntityMetadata(item.entityKind);
  const facts = entitySearchFacts(
    queryClient,
    item.entityKind,
    item.fieldFacts ?? {},
  );
  return facts.map((fact) => (
    <div
      key={fact.label}
      className="min-w-0 truncate text-xs sm:text-right"
      title={fact.label}
    >
      {fact.value !== null && (
        <>
          <span
            className={cn(
              "block text-muted-foreground",
              !fact.showLabel && "sm:sr-only",
            )}
          >
            {fact.label}:{" "}
          </span>
          {fact.value}
        </>
      )}
    </div>
  ));
}

/** The same fixed columns wrap beneath identity on narrow search surfaces. */
export function SearchFacts({
  item,
  mobile = false,
}: {
  item: SearchDestination;
  mobile?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-2 gap-x-4 gap-y-1",
        mobile
          ? "w-full"
          : "order-last w-full pl-10 sm:order-none sm:w-56 sm:shrink-0 sm:pl-0",
      )}
    >
      <DenseCellContext value={denseSearchCell}>
        <Suspense fallback={null}>
          <LoadedSearchFacts item={item} />
        </Suspense>
      </DenseCellContext>
    </div>
  );
}

export function SearchShortcode({ item }: { item: SearchDestination }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="w-20 shrink-0 text-right font-mono text-2xs text-muted-foreground tabular-nums"
            aria-label={`${entities[item.entityKind].label} ${item.id}`}
          />
        }
      >
        {item.id}
      </TooltipTrigger>
      <TooltipContent>
        {entities[item.entityKind].label} · {item.id}
      </TooltipContent>
    </Tooltip>
  );
}
