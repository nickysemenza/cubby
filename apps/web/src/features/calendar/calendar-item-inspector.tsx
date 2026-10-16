import type { CalendarItem } from "@cubby/schemas/calendar";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { EntityQualityFact } from "~/entity/display/data-quality-value";
import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { fieldClearing } from "~/entity/editing/field-clearing";
import type { EntityMutationPort } from "~/entity/editing/types";
import { useEntityEditSession } from "~/entity/editing/use-entity-edit-session";
import { entityDetailLink } from "~/entity/entities";
import { PickerField } from "~/entity/forms/picker-field";
import { FieldSuggestionProvider } from "~/entity/suggestions/field-suggestion-provider";
import { formatCurrency } from "~/lib/number-format";
import { showErrorToast } from "~/ui/feedback/error-details";
import {
  FormWrapper,
  NullableNumericField,
  PlainDateField,
  UnifiedTextField,
} from "~/ui/forms/form-utils";
import { useIsMobile } from "~/ui/hooks/use-mobile";
import { Stack } from "~/ui/layout";
import { Overlay } from "~/ui/overlays/overlay";
import { Button } from "~/ui/primitives/button";
import {
  Popover,
  PopoverContent,
  type PopoverHandle,
  PopoverHeader,
  PopoverTitle,
} from "~/ui/primitives/popover";

import { DuplicateMealButton } from "../meal/copy-meals";
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
      <Overlay
        placement="panel"
        open={open}
        onOpenChange={(open) => {
          if (!open) handle.close();
        }}
        title={item.title}
        description={`${item.kind === "expense" && item.future ? "Planned expense" : item.kind} on the household calendar`}
        className="sm:max-w-md"
      >
        {content}
      </Overlay>
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
        {item.kind === "meal" ? (
          <EntityQualityFact
            entity="meal"
            id={item.id}
            quality={item.dataQuality}
          />
        ) : null}
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
  const receiptHandler = useRef<((recordId: string) => Promise<void>) | null>(
    null,
  );
  const error = session.issues.find((issue) => !issue.field)?.message;

  return (
    <FormWrapper
      form={session.form}
      onSubmit={() => {
        void session.submit().then(async (result) => {
          if (!result.ok) return;
          if (item.kind === "meal") {
            try {
              await receiptHandler.current?.(item.id);
            } catch (error) {
              showErrorToast(error, "Saved, but suggestion receipt failed");
            }
          }
          onSaved?.();
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
          receiptHandler={receiptHandler}
          fieldKeys={["mealType", "mealKind"]}
        >
          <PickerField
            store="option"
            form={session.form}
            name="mealType"
            label="Meal type"
            options={fieldEnumOptions("meal", "mealType")}
            nullable
            suggestField="mealType"
          />
          <PickerField
            store="option"
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
          <PickerField
            store="option"
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
      {item.kind === "meal" && (
        <DuplicateMealButton mealId={item.id} onDuplicated={onSaved} />
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
