import type { CalendarItem } from "@cubby/schemas/calendar";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { FieldSuggestionProvider } from "~/app/_components/ai/field-suggestion-provider";
import {
  FormWrapper,
  NullableNumericField,
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "~/app/_components/form-utils";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Popover,
  PopoverContent,
  type PopoverHandle,
  PopoverHeader,
  PopoverTitle,
} from "~/components/ui/popover";
import { ResponsiveSheet } from "~/components/ui/responsive-sheet";
import { fieldClearing } from "~/entities/editing/field-clearing";
import type { EntityMutationPort } from "~/entities/editing/types";
import { useEntityEditSession } from "~/entities/editing/use-entity-edit-session";
import { entityDetailLink } from "~/entities/entities";
import { fieldEnumOptions } from "~/entities/enum-field-display";
import { useIsMobile } from "~/hooks/useMobile";
import { formatCurrency } from "~/lib/utils";

import { CalendarItemPresentation, itemMetadata } from "./calendar-item-row";
import { calendarItemEditDescriptor } from "./calendar-kind-registry";

interface CalendarItemInspectorProps {
  handle: PopoverHandle<CalendarItem>;
}

export interface CalendarItemInspectorOperations {
  readonly mutationPort?: EntityMutationPort;
}

function CalendarItemInspector({ handle }: CalendarItemInspectorProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover handle={handle} onOpenChange={setOpen}>
      {({ payload }) => {
        const item = payload;
        return item ? (
          <CalendarInspectorOverlay
            key={`${item.kind}:${item.id}`}
            item={item}
            handle={handle}
            open={open}
          />
        ) : null;
      }}
    </Popover>
  );
}

function CalendarInspectorOverlay({
  item,
  handle,
  open,
}: CalendarItemInspectorProps & { item: CalendarItem; open: boolean }) {
  const isMobile = useIsMobile();
  const content = (
    <CalendarInspectorBody
      item={item}
      onCancel={() => handle.close()}
      onSaved={() => handle.close()}
    />
  );

  if (isMobile) {
    return (
      <ResponsiveSheet
        open={open}
        onOpenChange={(open) => {
          if (!open) handle.close();
        }}
        title={item.title}
        description={`${item.kind === "expense" && item.future ? "Planned expense" : item.kind} on the household calendar`}
        className="sm:max-w-md"
      >
        {content}
      </ResponsiveSheet>
    );
  }

  return (
    <PopoverContent
      align="start"
      sideOffset={6}
      className="w-80 gap-2 p-4"
      aria-label={`Edit ${item.title}`}
    >
      <PopoverHeader className="border-b pb-2">
        <PopoverTitle>{item.title}</PopoverTitle>
        <div className="text-muted-foreground">{itemMetadata(item)}</div>
      </PopoverHeader>
      {content}
    </PopoverContent>
  );
}

function CalendarInspectorBody({
  item,
  onCancel,
  onSaved,
  operations,
}: {
  item: CalendarItem;
  onCancel: () => void;
  onSaved?: () => void;
  operations?: CalendarItemInspectorOperations;
}) {
  const edit = calendarItemEditDescriptor(item);
  if (edit.mode === "read-only") {
    return <ReadOnlyCalendarItem item={item} reason={edit.reason} />;
  }
  return (
    <EditableCalendarItem
      item={item}
      edit={edit}
      onCancel={onCancel}
      onSaved={onSaved}
      operations={operations}
    />
  );
}

function EditableCalendarItem({
  item,
  edit,
  onCancel,
  onSaved,
  operations,
}: {
  item: CalendarItem;
  edit: Extract<
    ReturnType<typeof calendarItemEditDescriptor>,
    { mode: "editable" }
  >;
  onCancel: () => void;
  onSaved?: () => void;
  operations?: CalendarItemInspectorOperations;
}) {
  const session = useEntityEditSession(
    {
      entity: edit.entity,
      operation: "update",
      intent: edit.intent,
      surface: "calendar",
      record: edit.record,
    },
    operations,
  );
  const error = session.issues.find((issue) => !issue.field)?.message;

  return (
    <FormWrapper
      form={session.form}
      onSubmit={() => {
        void session.submit().then((result) => {
          if (result.ok) onSaved?.();
        });
      }}
      error={error}
      isPending={session.isPending}
      onCancel={onCancel}
      submitButtonText="Save"
    >
      <UnifiedTextField
        form={session.form}
        name="name"
        label="Name"
        placeholder={item.kind === "meal" ? "Meal name (optional)" : "Name"}
        nullable={item.kind === "meal"}
      />
      <PlainDateField
        form={session.form}
        name={item.kind === "task" ? "dueDate" : "date"}
        label={item.kind === "task" ? "Due date" : "Date"}
        {...fieldClearing(
          edit.entity,
          "date",
          item.kind === "expense",
          session.form.watch("cost"),
        )}
      />
      {item.kind === "meal" && (
        <FieldSuggestionProvider
          entity="meal"
          mode="edit"
          fieldKeys={["mealType", "mealKind"]}
        >
          <SelectField
            form={session.form}
            name="mealType"
            label="Meal type"
            options={fieldEnumOptions("meal", "mealType")}
            nullable
            suggestField="mealType"
          />
          <SelectField
            form={session.form}
            name="mealKind"
            label="Kind"
            options={fieldEnumOptions("meal", "mealKind")}
            suggestField="mealKind"
          />
        </FieldSuggestionProvider>
      )}
      {item.kind === "task" && (
        <>
          <PlainDateField
            form={session.form}
            name="dueEndDate"
            label="Due through"
          />
          <SelectField
            form={session.form}
            name="status"
            label="Status"
            options={fieldEnumOptions("task", "status")}
          />
        </>
      )}
      {item.kind === "expense" && (
        <NullableNumericField
          form={session.form}
          name="cost"
          label="Planned cost"
          placeholder="0.00"
          prefix="$"
          step="0.01"
        />
      )}
      <OpenFullRecord item={item} />
    </FormWrapper>
  );
}

function ReadOnlyCalendarItem({
  item,
  reason,
}: {
  item: CalendarItem;
  reason: string;
}) {
  return (
    <Stack gap="sm">
      <div className="border-y py-2">
        <CalendarItemPresentation item={item} variant="rich" />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
        <dt className="font-mono text-slate uppercase">Dates</dt>
        <dd>
          {item.startDate} – {item.endDateExclusive}
        </dd>
        {item.kind === "expense" && item.cost != null && (
          <>
            <dt className="font-mono text-slate uppercase">Amount</dt>
            <dd>{formatCurrency(item.cost)}</dd>
          </>
        )}
      </dl>
      <p className="text-muted-foreground">{reason}</p>
      <OpenFullRecord item={item} />
    </Stack>
  );
}

function OpenFullRecord({ item }: { item: CalendarItem }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      render={<Link {...entityDetailLink(item.kind, item.id)} />}
      nativeButton={false}
    >
      Open full record
      <ArrowSquareOutIcon className="size-3.5" />
    </Button>
  );
}

export { CalendarInspectorBody, CalendarItemInspector, EditableCalendarItem };
