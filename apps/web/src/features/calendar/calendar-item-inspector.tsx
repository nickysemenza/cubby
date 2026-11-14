import { calendarItemKey, type CalendarItem } from "@cubby/schemas/calendar";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { addDays } from "date-fns";
import { useId, useMemo, useState } from "react";

import { EntityQualityFact } from "~/entity/display/data-quality-value";
import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { fieldClearing } from "~/entity/editing/field-clearing";
import type { EntityMutationPort } from "~/entity/editing/types";
import { useEntityEditSession } from "~/entity/editing/use-entity-edit-session";
import { entityDetailLink } from "~/entity/entities";
import { WhyValue } from "~/entity/fields/explanation/why-value";
import { InheritedMarker } from "~/entity/fields/field-resolution";
import { PickerField } from "~/entity/forms/picker-field";
import { CategoryLabelById } from "~/entity/presentation/category-label";
import { SpendingCategoryLabel } from "~/entity/presentation/spending-category-label";
import { FieldSuggestionProvider } from "~/entity/suggestions/field-suggestion-provider";
import { formatDateSpan } from "~/lib/date-span";
import { formatCurrency } from "~/lib/number-format";
import { formatPlainDate, parsePlainDate } from "~/lib/plain-date";
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
import { Facts, FactsDensityProvider } from "~/ui/records/facts";
import { RecordList, RecordRow } from "~/ui/records/record-list";

import { DuplicateMealButton } from "../meal/copy-meals";
import {
  CalendarItemAmount,
  CalendarItemPresentation,
  itemMetadata,
} from "./calendar-item-row";
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
        <div className="flex min-w-0 items-baseline gap-2">
          <PopoverTitle className="min-w-0 flex-1">{item.title}</PopoverTitle>
          <CalendarItemAmount item={item} className="text-base font-semibold" />
        </div>
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
      {/* Spending facts below restate the rich row, so only other sources show it. */}
      {item.kind !== "expense" && item.kind !== "purchase" && (
        <div className="border-y py-2">
          <CalendarItemPresentation item={item} variant="rich" />
        </div>
      )}
      <FactsDensityProvider density="compact">
        <Facts
          layout="list"
          facts={[
            {
              label: spansOneDay(item) ? "Date" : "Dates",
              value: formatDateSpan(
                item.startDate,
                spansOneDay(item) ? null : lastDay(item),
              ),
            },
            {
              label: "Amount",
              value:
                (item.kind === "expense" || item.kind === "purchase") &&
                item.cost != null
                  ? formatCurrency(item.cost)
                  : undefined,
              className: "font-mono tabular-nums",
            },
            ...spendingFacts(item),
          ]}
        />
      </FactsDensityProvider>
      {(item.kind === "expense" || item.kind === "purchase") && (
        <ProductCategoryBreakdown item={item} />
      )}
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

type SpendingItem = Extract<CalendarItem, { kind: "expense" | "purchase" }>;

const lastDay = (item: CalendarItem) =>
  formatPlainDate(addDays(parsePlainDate(item.endDateExclusive), -1));
const spansOneDay = (item: CalendarItem) => lastDay(item) === item.startDate;

const PURCHASE_BASIS_LABELS = {
  stated_total: "Receipt total",
  expense_lines: "Sum of spending lines",
  settlement: "Card settlement",
  unknown: "Unknown",
} satisfies Record<
  Extract<CalendarItem, { kind: "purchase" }>["basis"],
  string
>;

/** Category, Project and beneficiary facts; inherited beneficiaries keep their marker here. */
function spendingFacts(item: CalendarItem) {
  if (item.kind !== "expense" && item.kind !== "purchase") return [];
  const context = item.spendingContext;
  const categories = context?.spendingCategories ?? [];
  return [
    ...(item.kind === "purchase"
      ? [
          {
            label: "Amount basis",
            value: PURCHASE_BASIS_LABELS[item.basis],
          },
        ]
      : []),
    {
      label:
        categories.length > 1 ? "Spending categories" : "Spending category",
      value: categories.length ? (
        <span className="flex min-w-0 flex-col items-start gap-1">
          {categories.map((category) => (
            <span
              key={category.id}
              className="flex max-w-full min-w-0 items-center gap-1.5"
            >
              <SpendingCategoryLabel
                id={category.id}
                name={category.name}
                emoji={category.emoji}
              />
              {categories.length > 1 && category.amount !== null && (
                <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                  {formatCurrency(category.amount)}
                </span>
              )}
            </span>
          ))}
        </span>
      ) : undefined,
    },
    {
      label: "Project",
      value: context?.projectNames.length
        ? context.projectNames.join(", ")
        : undefined,
    },
    {
      label: "For",
      value: context?.parties.length ? (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {context.parties.map((party) => (
            <span key={party.id} className="inline-flex items-center gap-1">
              {party.name}
              {party.inherited && <InheritedMarker />}
            </span>
          ))}
        </span>
      ) : undefined,
    },
  ];
}

/** Lines grouped by their Product's category, largest share first. */
function ProductCategoryBreakdown({ item }: { item: SpendingItem }) {
  const categories = item.spendingContext?.productCategories ?? [];
  if (categories.length === 0) return null;
  return (
    <Stack gap="xs">
      <span className="text-xs font-medium text-muted-foreground">
        By product category
      </span>
      <RecordList aria-label="Spending by product category">
        {categories.map((category) => (
          <RecordRow
            key={category.id}
            clip={false}
            primary={
              <CategoryLabelById id={category.id} name={category.name} />
            }
            secondary={`${category.lineCount} ${category.lineCount === 1 ? "line" : "lines"}`}
            trailing={
              category.amount === null ? (
                "Unknown amount"
              ) : (
                <span className="font-mono tabular-nums">
                  {formatCurrency(category.amount)}
                </span>
              )
            }
          />
        ))}
      </RecordList>
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
              line.cost === null ? (
                "Unknown amount"
              ) : (
                <span className="font-mono tabular-nums">
                  {formatCurrency(line.cost)}
                </span>
              )
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
