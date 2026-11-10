import { entityRoster } from "@cubby/schemas/entity-roster";
import { parseShortcode } from "@cubby/shared";
import { countLabel } from "@cubby/shared/pluralize";
import { useState, type ReactNode } from "react";
import { z } from "zod";

import { RecordProposals } from "~/entity/suggestions/queue/record-proposals";
import { Button } from "~/ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";

const identity = z.object({
  id: z.string(),
  pendingSuggestionCount: z.number().int().nonnegative().optional(),
});

export function ProposalCount({
  record,
  field,
  children,
}: {
  record: unknown;
  field?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const row = identity.safeParse(record);
  const code = row.success ? parseShortcode(row.data.id) : null;
  if (
    !code ||
    (field !== undefined && field !== entityRoster[code.type].titleField)
  )
    return children;
  const count = row.success ? (row.data.pendingSuggestionCount ?? 0) : 0;
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1">
      <span className="min-w-0">{children}</span>
      {count > 0 ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                className="relative z-[1] shrink-0 tabular-nums"
                aria-label={countLabel(count, "pending suggestion")}
                onClick={(event) => event.stopPropagation()}
              />
            }
          >
            {count}
          </PopoverTrigger>
          <PopoverContent
            className="max-h-[70vh] w-[min(56rem,calc(100vw-2rem))] overflow-y-auto"
            onClick={(event) => event.stopPropagation()}
          >
            {open ? <RecordProposals id={code.shortcode} /> : null}
          </PopoverContent>
        </Popover>
      ) : null}
    </span>
  );
}
