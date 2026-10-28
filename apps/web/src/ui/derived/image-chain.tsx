import type { Entity } from "@cubby/schemas/entity";
import type { imageChainExplanation } from "@cubby/schemas/field-explanation";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { z } from "zod";

import { fieldExplanation } from "~/integrations/tanstack-query/domains/fieldExplanation";
import { cn } from "~/lib/utils";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Button } from "~/ui/primitives/button";
import { Image } from "~/ui/primitives/image";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverTitle,
} from "~/ui/primitives/popover";

import { SourceStack } from "./source-stack";
import { ExplanationEntityLink } from "./why-value";

export type ImageChainQueryOptions =
  typeof fieldExplanation.imageChain.queryOptions;

type Chain = z.infer<typeof imageChainExplanation>;

export function ImageChain({ chain }: { chain: Chain }) {
  return (
    <SourceStack
      label="Display image chain"
      rows={chain.levels.map((level) => ({
        key: `${level.source?.entityId ?? "default"}:${level.label}`,
        status: level.images.some((image) => image.chosen)
          ? "deciding"
          : "skipped",
        title: level.source ? (
          <ExplanationEntityLink
            entity={level.source.entityKind}
            id={level.source.entityId}
            name={level.label}
          />
        ) : (
          level.label
        ),
        children: (
          <>
            {level.images.length ? (
              <div className="flex gap-2 overflow-x-auto p-1">
                {level.images.map((image) => (
                  <figure key={image.id} className="shrink-0">
                    <Image
                      src={image.url}
                      alt={
                        image.chosen ? "Chosen cover" : `${level.label} image`
                      }
                      displayWidth={64}
                      className={cn(
                        "size-16 rounded-md object-cover",
                        image.chosen &&
                          "outline-2 outline-offset-2 outline-info",
                      )}
                    />
                    {image.chosen ? (
                      <figcaption className="mt-1 text-xs text-muted-foreground">
                        Cover
                      </figcaption>
                    ) : null}
                  </figure>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No images</p>
            )}
          </>
        ),
      }))}
    />
  );
}

export function RecordImageChain({
  entity,
  id,
  explain = fieldExplanation.imageChain.queryOptions,
}: {
  entity: Entity;
  id: string;
  explain?: ImageChainQueryOptions;
}) {
  const result = useQuery(
    explain({
      entityKind: entity,
      entityId: id,
    }),
  );
  if (result.isError)
    return <ErrorDisplay error={result.error} title="display image chain" />;
  if (result.isPending)
    return (
      <p className="text-xs text-muted-foreground">Loading image sources…</p>
    );
  return <ImageChain chain={result.data} />;
}

export function ImageChainPopover({
  entity,
  id,
  children,
}: {
  entity: Entity;
  id: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            className="h-auto p-0"
            aria-label="Why this image"
          />
        }
      >
        {children}
      </PopoverTrigger>
      <PopoverContent className="max-h-[85dvh] w-[min(28rem,calc(100vw-1rem))] overflow-y-auto">
        <PopoverTitle className="mb-3 text-sm font-semibold">
          Display image sources
        </PopoverTitle>
        {open ? <RecordImageChain entity={entity} id={id} /> : null}
      </PopoverContent>
    </Popover>
  );
}
