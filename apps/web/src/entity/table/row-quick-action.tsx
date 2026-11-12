import type { Entity } from "@cubby/schemas/entity";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { useState } from "react";

import { verbDef } from "~/entity/actions/action-verbs";
import { useEntityRowQuickAction } from "~/entity/actions/entity-actions";
import { readRecordState } from "~/entity/display/list-renderers/generic-state";
import { showErrorToast } from "~/ui/feedback/error-details";
import { Button } from "~/ui/primitives/button";

/**
 * The row's quick command beside its menu: the first declared
 * `list.quickActions` verb the row offers. A row that needs the member shows
 * it always; other rows show it on hover or focus.
 */
export function RowQuickAction<TRow extends { id: string | number }>({
  entity,
  row,
}: {
  entity: Entity;
  row: TRow;
}) {
  const queryClient = useQueryClient();
  const quick = useEntityRowQuickAction(entity, row);
  const [pending, setPending] = useState(false);
  if (!quick) return null;
  const state = readRecordState(queryClient, entity, row);
  const needs = state?.phase === "needs" || state?.stalled === true;
  const { label, icon: Icon } = verbDef(quick.verb);
  return (
    <Button
      variant={needs ? "default" : "outline"}
      size="xs"
      disabled={pending}
      className={cn(
        !needs &&
          "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
      )}
      onClick={async (event) => {
        event.stopPropagation();
        setPending(true);
        try {
          await quick.run();
        } catch (error) {
          showErrorToast(error);
        } finally {
          setPending(false);
        }
      }}
    >
      <Icon aria-hidden data-icon="inline-start" />
      {label}
    </Button>
  );
}
