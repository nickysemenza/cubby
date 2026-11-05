import { calendarItemKey, type CalendarItem } from "@cubby/schemas/calendar";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useMemo, useRef, useState } from "react";

import { EntityQualityFact } from "~/entity/display/data-quality-value";
import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { fieldClearing } from "~/entity/editing/field-clearing";
import type { EntityMutationPort } from "~/entity/editing/types";
import { useEntityEditSession } from "~/entity/editing/use-entity-edit-session";
import { entityDetailLink } from "~/entity/entities";
import { PickerField } from "~/entity/forms/picker-field";
import { FieldSuggestionProvider } from "~/entity/suggestions/field-suggestion-provider";
import { formatCurrency } from "~/lib/number-format";
import { Facts, FactsDensityProvider } from "~/ui/common/facts";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import { WhyValue } from "~/ui/derived/why-value";
import { showErrorToast } from "~/ui/feedback/error-details";
import { DateRangeField } from "~/ui/forms/date-span-field";
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
            key={calendarItemKey(item)}
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
      <CalendarInspectorBody
        item={item}
        onCancel={() => handle.close()}
        onSaved={() => handle.close()}
        overlay={{
          open,
          onOpenChange: (next) => {
            if (!next) handle.close();
          },
        }}
      />
    );
  }

  return (
    <PopoverContent
      align="start"
      sideOffset={6}
      className="max-h-[80dvh] w-80 gap-2 overflow-y-auto p-4"
      aria-label={`${item.interaction === "read-only" ? "View" : "Edit"} ${item.title}`}
    >
      <PopoverHeader className="border-b pb-2">
        <PopoverTitle>{item.title}</PopoverTitle>
        {item.kind === "meal" ? (
          <EntityQualityFact
            entity="meal"
            id={item.id}
            envelope={item.source.fields.dataQuality}
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
  overlay,
}: {
  item: CalendarItem;
  onCancel: () => void;
  onSaved?: () => void;
  operations?: CalendarItemInspectorOperations;
  overlay?: { open: boolean; onOpenChange: (open: boolean) => void };
}) {
  const edit = calendarItemEditDescriptor(item);
  if (edit.mode === "read-only") {
    const content = <ReadOnlyCalendarItem item={item} reason={edit.reason} />;
    return overlay ? (
      <Overlay {...overlay} title={item.title} description={itemMetadata(item)}>
        {content}
      </Overlay>
    ) : (
      content
    );
  }
  return (
    <EditableCalendarItem
      item={item}
      edit={edit}
      onCancel={onCancel}
      onSaved={onSaved}
      operations={operations}
      overlay={overlay}
    />
  );
}

function EditableCalendarItem({
  item,
  edit,
  onCancel,
  onSaved,
  operations,
  overlay,
}: {
  item: CalendarItem;
  edit: Extract<
    ReturnType<typeof calendarItemEditDescriptor>,
    { mode: "editable" }
  >;
  onCancel: () => void;
  onSaved?: () => void;
  operations?: CalendarItemInspectorOperations;
  overlay?: { open: boolean; onOpenChange: (open: boolean) => void };
}) {
  const queryClient = useQueryClient();
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
  // The edit session admits this item's entity before enum compilation.
  const options = useMemo(() => {
    switch (item.kind) {
      case "meal":
        return {
          kind: item.kind,
          mealType: fieldEnumOptions(queryClient, "meal", "mealType"),
          mealKind: fieldEnumOptions(queryClient, "meal", "mealKind"),
        };
      case "task":
        return {
          kind: item.kind,
          status: fieldEnumOptions(queryClient, "task", "status"),
        };
      default:
        return { kind: item.kind };
    }
  }, [queryClient, item.kind]);
  const receiptHandler = useRef<((recordId: string) => Promise<void>) | null>(
    null,
  );
  const formId = useId();
  const [submitting, setSubmitting] = useState(false);
  const busy = submitting || session.isPending;
  const error = session.issues.find((issue) => !issue.field)?.message;

  const content = (
    <FormWrapper
      form={session.form}
      id={formId}
      hideActions={overlay != null}
      footerMode={overlay ? "dialog" : "inline"}
      onSubmittingChange={setSubmitting}
      onSubmit={async () => {
        await session.submit().then(async (result) => {
          if (!result.ok) return;
          if (item.kind === "meal") {
            try {
              await receiptHandler.current?.(item.id);
            } catch (error) {
              showErrorToast(error, "Saved, but suggestion receipt failed");
            }
          }
          await onSaved?.();
        });
      }}
      error={error}
      isPending={busy}
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
      {item.kind === "task" ? (
        <DateRangeField
          form={session.form}
          name="due"
          label="Due"
          semantics="deadline"
          clearable
        />
      ) : (
        <PlainDateField
          form={session.form}
          name="date"
          label="Date"
          {...fieldClearing(
            edit.entity,
            "date",
            item.kind === "expense",
            session.form.watch("cost"),
          )}
        />
      )}
      {options.kind === "meal" && (
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
            options={options.mealType}
            nullable
            suggestField="mealType"
          />
          <PickerField
            store="option"
            form={session.form}
            name="mealKind"
            label="Kind"
            options={options.mealKind}
            suggestField="mealKind"
          />
        </FieldSuggestionProvider>
      )}
      {options.kind === "task" && (
        <>
          <PickerField
            store="option"
            form={session.form}
            name="status"
            label="Status"
            options={options.status}
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
      <CalendarBeneficiaryExplanations item={item} />
      <OpenFullRecord item={item} />
    </FormWrapper>
  );
  return overlay ? (
    <Overlay
      {...overlay}
      title={item.title}
      description={itemMetadata(item)}
      bodyMode="form"
      pending={busy}
      primary={{ label: "Save", pendingLabel: "Saving…", form: formId }}
      onCancel={onCancel}
    >
      {content}
    </Overlay>
  ) : (
    content
  );
}

function CalendarBeneficiaryExplanations({ item }: { item: CalendarItem }) {
  if (item.kind !== "expense" && item.kind !== "purchase") return null;
  const sources = item.spendingContext?.beneficiarySources ?? [];
  if (sources.length === 0) return null;
  return (
    <Facts
      layout="list"
      facts={sources.map((source) => ({
        label: source.name,
        value: (
          <WhyValue
            entity="expense"
            id={source.id}
            field="effectiveBeneficiaries"
            label={`${source.name} beneficiaries`}
          />
        ),
      }))}
    />
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
      <FactsDensityProvider density="compact">
        <Facts
          layout="list"
          facts={[
            {
              label: "Dates",
              value: `${item.startDate} – ${item.endDateExclusive}`,
            },
            {
              label: "Amount",
              value:
                (item.kind === "expense" || item.kind === "purchase") &&
                item.cost != null
                  ? formatCurrency(item.cost)
                  : undefined,
              className: "tabular-nums",
            },
          ]}
        />
      </FactsDensityProvider>
      {item.kind === "purchase" && <PurchaseBreakdown item={item} />}
      {item.kind === "purchase" && item.evidenceNote && (
        <p>{item.evidenceNote}</p>
      )}
      <p className="text-muted-foreground">{reason}</p>
      <CalendarBeneficiaryExplanations item={item} />
      <OpenFullRecord item={item} />
    </Stack>
  );
}

function PurchaseBreakdown({
  item,
}: {
  item: Extract<CalendarItem, { kind: "purchase" }>;
}) {
  return (
    <Stack gap="sm">
      {item.cost !== item.ledgerAmount && (
        <FactsDensityProvider density="compact">
          <Facts
            layout="list"
            facts={[
              {
                label: "Recorded spend",
                value: formatCurrency(item.ledgerAmount),
                className: "font-mono tabular-nums",
              },
            ]}
          />
        </FactsDensityProvider>
      )}
      <RecordList
        aria-label="Purchase spending lines"
        empty="No spending lines recorded."
      >
        {item.lines.map((line) => (
          <RecordRow
            key={line.id}
            clip={false}
            primary={
              <Link {...entityDetailLink("expense", line.id)}>{line.name}</Link>
            }
            secondary={line.productName}
            trailing={
              line.cost === null ? "Unknown amount" : formatCurrency(line.cost)
            }
          />
        ))}
      </RecordList>
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
