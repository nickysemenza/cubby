import type { CalendarItem } from "@cubby/schemas/calendar";
import type { MealKind, MealType } from "@cubby/schemas/meal-classification";
import type { TaskStatus } from "@cubby/schemas/project";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import {
  FormWrapper,
  NullableNumericField,
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "~/app/_components/form-utils";
import { mealKindOptions, mealTypeOptions } from "~/app/meals/meal-options";
import { taskStatusOptions } from "~/app/tasks/task-options";
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
import { entityDetailLink } from "~/entities/entities";
import { useIsMobile } from "~/hooks/useMobile";
import { getErrorMessage } from "~/lib/error-utils";
import { formatCurrency } from "~/lib/utils";
import { CalendarItemPresentation, itemMetadata } from "./calendar-item-row";

interface CalendarEditorValues {
  name: string;
  date: string | null;
  endDate: string | null;
  mealType: MealType | null;
  mealKind: MealKind;
  status: TaskStatus;
  cost: number | null;
}

interface CalendarItemInspectorProps {
  handle: PopoverHandle<CalendarItem>;
  onSave: (item: CalendarItem, values: CalendarEditorValues) => Promise<void>;
}

function CalendarItemInspector({ handle, onSave }: CalendarItemInspectorProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover handle={handle} onOpenChange={setOpen}>
      {({ payload }) => {
        const item = payload as CalendarItem | undefined;
        return item ? (
          <CalendarInspectorOverlay
            key={`${item.kind}:${item.id}`}
            item={item}
            handle={handle}
            open={open}
            onSave={onSave}
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
  onSave,
}: CalendarItemInspectorProps & { item: CalendarItem; open: boolean }) {
  const isMobile = useIsMobile();
  const content = (
    <CalendarInspectorBody
      item={item}
      onCancel={() => handle.close()}
      onSave={async (values) => {
        await onSave(item, values);
        handle.close();
      }}
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
  onSave,
}: {
  item: CalendarItem;
  onCancel: () => void;
  onSave: (values: CalendarEditorValues) => Promise<void>;
}) {
  if (item.kind === "project" || (item.kind === "expense" && !item.future)) {
    return <ReadOnlyCalendarItem item={item} />;
  }
  return (
    <EditableCalendarItem item={item} onCancel={onCancel} onSave={onSave} />
  );
}

function EditableCalendarItem({
  item,
  onCancel,
  onSave,
}: {
  item: Exclude<CalendarItem, { kind: "project" }>;
  onCancel: () => void;
  onSave: (values: CalendarEditorValues) => Promise<void>;
}) {
  const form = useForm<CalendarEditorValues>({
    defaultValues: editorDefaults(item),
  });
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    form.reset(editorDefaults(item));
    setError(undefined);
  }, [form, item]);

  const submit = async (values: CalendarEditorValues) => {
    form.clearErrors();
    setError(undefined);
    const nameRequired = item.kind !== "meal";
    if (nameRequired && !values.name.trim()) {
      form.setError("name", { message: "Name is required" });
      return;
    }
    if (!values.date) {
      form.setError("date", { message: "Date is required" });
      return;
    }
    if (
      item.kind === "task" &&
      values.endDate &&
      values.endDate < values.date
    ) {
      form.setError("endDate", {
        message: "End date must be on or after the due date",
      });
      return;
    }

    setIsPending(true);
    try {
      await onSave(values);
    } catch (cause) {
      setError(
        getErrorMessage(cause) || "The calendar item could not be saved.",
      );
    } finally {
      setIsPending(false);
    }
  };

  return (
    <FormWrapper
      form={form}
      onSubmit={(values) => void submit(values)}
      error={error}
      isPending={isPending}
      onCancel={onCancel}
      submitButtonText="Save"
    >
      <UnifiedTextField
        form={form}
        name="name"
        label="Name"
        placeholder={item.kind === "meal" ? "Meal name (optional)" : "Name"}
      />
      <PlainDateField
        form={form}
        name="date"
        label={item.kind === "task" ? "Due date" : "Date"}
      />
      {item.kind === "meal" && (
        <>
          <SelectField
            form={form}
            name="mealType"
            label="Meal type"
            options={mealTypeOptions}
            nullable
          />
          <SelectField
            form={form}
            name="mealKind"
            label="Kind"
            options={mealKindOptions}
          />
        </>
      )}
      {item.kind === "task" && (
        <>
          <PlainDateField form={form} name="endDate" label="Due through" />
          <SelectField
            form={form}
            name="status"
            label="Status"
            options={taskStatusOptions}
          />
        </>
      )}
      {item.kind === "expense" && (
        <NullableNumericField
          form={form}
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

function ReadOnlyCalendarItem({ item }: { item: CalendarItem }) {
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
      <p className="text-muted-foreground">
        {item.kind === "project"
          ? "Project dates are derived from its work and spending. Edit the full project to change its record."
          : "Recorded expenses stay read-only in the calendar. Open the full expense to make ledger changes."}
      </p>
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
      <ExternalLink className="size-3.5" />
    </Button>
  );
}

function editorDefaults(
  item: Exclude<CalendarItem, { kind: "project" }>,
): CalendarEditorValues {
  return {
    name: item.kind === "meal" ? (item.name ?? "") : item.title,
    date:
      item.kind === "task" ? (item.dueDate ?? item.dueEndDate) : item.startDate,
    endDate: item.kind === "task" && item.dueDate ? item.dueEndDate : null,
    mealType: item.kind === "meal" ? item.mealType : null,
    mealKind: item.kind === "meal" ? item.mealKind : "cooked",
    status: item.kind === "task" ? item.status : "not_started",
    cost: item.kind === "expense" ? item.cost : null,
  };
}

export type { CalendarEditorValues };
export { CalendarInspectorBody, CalendarItemInspector, EditableCalendarItem };
