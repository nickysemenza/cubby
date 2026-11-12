import type { Entity } from "@cubby/schemas/entity";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { useContext, useState } from "react";

import { verbDef } from "~/entity/actions/action-verbs";
import { useEntityRowQuickAction } from "~/entity/actions/entity-actions";
import { readRecordState } from "~/entity/display/list-renderers/generic-state";
import { SectionIndexRegistryContext } from "~/ui/data-table/detail-section-state";
import { showErrorToast } from "~/ui/feedback/error-details";
import { Button } from "~/ui/primitives/button";

/**
 * The row's quick command beside its menu: the first declared
 * `list.quickActions` verb the row offers. A row that needs the member shows
 * it always; other rows show it on hover or focus. A table inside a record's
 * section draws none: the record's own sections and header carry its
 * commands, and the verb stays in the row menu.
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
  const inRecord = useContext(SectionIndexRegistryContext) !== null;
  const [pending, setPending] = useState(false);
  if (!quick || inRecord) return null;
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
