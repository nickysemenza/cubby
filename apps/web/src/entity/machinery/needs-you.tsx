import { entitySchema } from "@cubby/schemas/entity";
import { kernelStageLabel } from "@cubby/schemas/field-envelope-presentation";
import { kernelStage } from "@cubby/schemas/kernel/stage";
import type { NeedsYouPage } from "@cubby/schemas/kernel/work";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import {
  browserEntityDetailLink,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { useMachineryActions } from "~/entity/machinery/record-machinery";
import { machinery } from "~/integrations/tanstack-query/generated/domains/machinery.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Section } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Skeleton } from "~/ui/primitives/skeleton";

function NeedsYouRow({ item }: { item: NeedsYouPage["items"][number] }) {
  const entity = entitySchema.parse(item.entity);
  const actions = useMachineryActions({ entity, id: item.shortcode });
  const action = item.actions.length === 1 ? item.actions[0] : null;
  return (
    <li className="grid min-w-0 gap-1 border-b border-border py-2 text-sm break-words">
      {isBrowserRoutedEntity(entity) ? (
        <Link
          {...browserEntityDetailLink(entity, item.shortcode)}
          className="w-fit text-link focus-visible:outline focus-visible:outline-2"
        >
          {item.shortcode}
        </Link>
      ) : (
        <span>{item.shortcode}</span>
      )}
      <p>{item.firstGap}</p>
      {action ? (
        <Button
          className="justify-self-start"
          size="sm"
          variant="outline"
          disabled={actions.pending}
          onClick={() => actions.act(action)}
        >
          {action.label}
        </Button>
      ) : null}
      <output className="text-xs text-muted-foreground">
        {actions.decided ? "Recorded. Cubby reworks this next." : null}
      </output>
      {actions.error ? (
        <ErrorDisplay error={actions.error} title="this decision" />
      ) : null}
    </li>
  );
}

export function NeedsYou() {
  const [offset, setOffset] = useState(0);
  const read = useQuery(machinery.needsYou.queryOptions({ limit: 50, offset }));
  return (
    <Section
      headingAs="h2"
      title="Needs you"
      count={read.data ? String(read.data.count) : undefined}
    >
      {read.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : read.isError ? (
        <ErrorDisplay
          error={read.error}
          title="Needs you"
          onRetry={() => void read.refetch()}
        />
      ) : read.data.count === 0 ? (
        <p>Nothing needs you.</p>
      ) : (
        <div className="grid min-w-0 gap-3">
          {kernelStage.options.map((stage) => {
            const items = read.data.items.filter(
              (item) => item.stage === stage,
            );
            return items.length ? (
              <section key={stage} aria-label={kernelStageLabel(stage)}>
                <h3 className="text-sm font-medium">
                  {kernelStageLabel(stage)}
                </h3>
                <ul>
                  {items.map((item) => (
                    <NeedsYouRow
                      key={`${item.entity}:${item.shortcode}`}
                      item={item}
                    />
                  ))}
                </ul>
              </section>
            ) : null;
          })}
          <p className="text-xs tabular-nums">
            Showing {offset + 1}–{offset + read.data.items.length} of{" "}
            {read.data.count}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={offset + read.data.items.length >= read.data.count}
              onClick={() => setOffset(offset + 50)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}
