import type { CalendarItemKind } from "@cubby/schemas/calendar";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";
import { calendarItemCreateRequest } from "./calendar-kind-registry";

interface CalendarCreateDialogProps {
  kind: CalendarItemKind;
  date?: string;
  onOpenChange: (open: boolean) => void;
}

export function CalendarCreateDialog({
  kind,
  date,
  onOpenChange,
}: CalendarCreateDialogProps) {
  return (
    <EntityEditDialog
      open
      onOpenChange={onOpenChange}
      request={calendarItemCreateRequest(kind, date)}
    />
  );
}
