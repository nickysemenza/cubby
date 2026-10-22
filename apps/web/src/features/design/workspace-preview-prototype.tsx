import type { FieldSuggestion } from "@cubby/schemas/ai";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { PackageIcon } from "@phosphor-icons/react/dist/csr/Package";
import { useId, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import { PickerField } from "~/entity/forms/picker-field";
import { Picker } from "~/entity/picker/picker";
import { SuggestionReview } from "~/entity/suggestions/suggestion-review";
import { formatCalendarDay } from "~/lib/date-format";

import "./workspace-preview-prototype.css";

import { formatPlainDate, parsePlainDate } from "~/lib/plain-date";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { DateDisplay } from "~/ui/common/date-display";
import { Facts } from "~/ui/common/facts";
import {
  RecordDetail,
  RecordDot,
  RecordHeading,
  RecordList,
  RecordRow,
} from "~/ui/common/record-list";
import { FormFieldGroup } from "~/ui/forms/form-field-group";
import { FormWrapper, UnifiedTextField } from "~/ui/forms/form-utils";
import { PageHeader } from "~/ui/layout/page-header";
import { Section } from "~/ui/layout/section";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Calendar } from "~/ui/primitives/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";

const products: ComboboxItem[] = [
  {
    id: "preview-purifier",
    name: "Air purifier",
    secondary: "Office · AP-200",
    icon: <PackageIcon />,
  },
  {
    id: "preview-filter",
    name: "Replacement filter",
    secondary: "Office · fits AP-200",
    icon: <PackageIcon />,
  },
  {
    id: "preview-fan",
    name: "Desk fan",
    secondary: "Office · USB powered",
    icon: <PackageIcon />,
  },
];
const projects: ComboboxItem[] = [
  {
    id: "preview-maintenance",
    name: "Seasonal maintenance",
    secondary: "House · Member A",
    icon: <FolderIcon />,
  },
  {
    id: "preview-office",
    name: "Home office refresh",
    secondary: "House · Member B",
    icon: <FolderIcon />,
  },
];
const proposal: FieldSuggestion = {
  value: "AP-200",
  label: "AP-200",
  confidence: "high",
  probability: 0.97,
  detail: null,
  reasoning:
    "The attached synthetic label explicitly states that this filter fits AP-200.",
  alternatives: [],
  operation: "set",
  removals: [],
};
const events = [
  {
    time: "2026-10-22T10:42:00-07:00",
    title: "Compatible model updated",
    change: "Not recorded → AP-200",
    source: "Accepted suggestion · package label",
    work: false,
  },
  {
    time: "2026-10-22T10:38:00-07:00",
    title: "Research completed",
    change: "1 proposed field change",
    source: "Attached label checked against the existing record",
    work: true,
  },
  {
    time: "2026-10-22T09:16:00-07:00",
    title: "Product attached to task",
    change: "Service air purifier",
    source: "Manual edit · Seasonal maintenance",
    work: false,
  },
  {
    time: "2026-10-21T15:20:00-07:00",
    title: "Source image attached",
    change: "Package label",
    source: "Manual attachment · 1 image",
    work: true,
  },
];

// Targeted, disposable refinements composed from Cubby's real components. No writes.
export function WorkspacePreviewPrototype() {
  const [surface, setSurface] = useState<string | null>("form");
  return (
    <div className="space-y-3 p-3 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
        <Picker
          mode="segmented"
          label="Targeted design previews"
          value={surface}
          onValueChange={setSurface}
          options={[
            { value: "form", label: "Task form" },
            { value: "review", label: "Suggestion review" },
            { value: "activity", label: "Activity" },
          ]}
        />
        <span className="text-xs text-muted-foreground">
          Actual shared components · synthetic records · local changes only
        </span>
      </div>
      {surface === "form" ? (
        <TaskFormPreview />
      ) : surface === "review" ? (
        <ReviewPreview />
      ) : (
        <ActivityPreview />
      )}
    </div>
  );
}

function TaskFormPreview() {
  const form = useForm({
    defaultValues: {
      name: "Service air purifier",
      status: "in_progress",
      trade: "",
      project: projects[0] ?? null,
      product: products[0] ?? null,
      dueDate: "2026-10-28",
      dueEndDate: "2026-10-30",
      notes:
        "Clean the pre-filter and check the replacement interval in the manual.",
    },
  });
  const dueDate = useWatch({ control: form.control, name: "dueDate" });
  const dueEndDate = useWatch({ control: form.control, name: "dueEndDate" });
  const [projectQuery, setProjectQuery] = useState("");
  const [productQuery, setProductQuery] = useState("");
  const [saved, setSaved] = useState(false);
  const statuses = useMemo(() => fieldEnumOptions("task", "status"), []);
  const trades = useMemo(() => fieldEnumOptions("task", "trade"), []);
  return (
    <div className="max-w-5xl space-y-3">
      <PageHeader
        title="Edit task"
        layout="inline"
        facts={["Service air purifier", "Seasonal maintenance"]}
      />
      <p className="text-xs text-muted-foreground">
        Tweak: group related fields, keep the real rich pickers, and align
        dates. Existing selection and validation behavior stays with its shared
        owner.
      </p>
      <FormWrapper
        form={form}
        isPending={false}
        submitButtonText="Save preview"
        onSubmit={() => setSaved(true)}
      >
        <Section title="Task" headingAs="h2" compact>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="md:col-span-2">
              <UnifiedTextField
                form={form}
                name="name"
                label="Name"
                placeholder="Task name"
              />
            </div>
            <PickerField
              form={form}
              name="project"
              store="item"
              entity="project"
              label="Project"
              items={projects.filter((x) =>
                x.name.toLowerCase().includes(projectQuery.toLowerCase()),
              )}
              onSearchChange={setProjectQuery}
            />
            <PickerField
              form={form}
              name="status"
              store="option"
              label="Status"
              options={statuses}
            />
            <PickerField
              form={form}
              name="product"
              store="item"
              entity="product"
              label="Subject product"
              items={products.filter((x) =>
                x.name.toLowerCase().includes(productQuery.toLowerCase()),
              )}
              onSearchChange={setProductQuery}
            />
            <PickerField
              form={form}
              name="trade"
              store="option"
              label="Trade"
              options={trades}
            />
          </div>
        </Section>
        <Section title="Schedule" headingAs="h2" compact>
          <DueWindowPreview
            start={dueDate}
            end={dueEndDate}
            onChange={(start, end) => {
              form.setValue("dueDate", start, { shouldDirty: true });
              form.setValue("dueEndDate", end, { shouldDirty: true });
            }}
          />
        </Section>
        <Section title="Context" headingAs="h2" compact>
          <Facts
            layout="list"
            facts={[
              {
                label: "Assignee",
                value: (
                  <EntityRefLink
                    variant="chip"
                    entity="ledgerParty"
                    id="LPY-2222"
                    name="Member A"
                    displayImage={null}
                  />
                ),
                caption: (
                  <span>
                    Inherited from{" "}
                    <EntityRefLink
                      entity="project"
                      data={{ id: "PRJ-2222", name: "Seasonal maintenance" }}
                      displayImage={null}
                    />
                  </span>
                ),
              },
              {
                label: "Parent task",
                value: (
                  <EntityRefLink
                    entity="task"
                    data={{ id: "TSK-2222", name: "Prepare rooms for winter" }}
                    displayImage={null}
                    wrap
                  />
                ),
              },
              {
                label: "Blocked by",
                value: (
                  <EntityRefLink
                    entity="task"
                    data={{
                      id: "TSK-2223",
                      name: "Check replacement filter model",
                    }}
                    displayImage={null}
                    wrap
                  />
                ),
              },
            ]}
          />
          <UnifiedTextField
            form={form}
            name="notes"
            label="Notes"
            placeholder="Working notes"
          />
        </Section>
      </FormWrapper>
      {saved && (
        <output className="flex items-center gap-1 text-xs text-positive">
          <CheckCircleIcon /> Saved in this preview only
        </output>
      )}
    </div>
  );
}

function ReviewPreview() {
  const [value, setValue] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  return (
    <div className="max-w-5xl space-y-3">
      <PageHeader
        title="Replacement filter"
        layout="inline"
        facts={["Product", "Office"]}
        status={<Badge variant="secondary">Needs you</Badge>}
      />
      <p className="text-xs text-muted-foreground">
        Tweak: show evidence beside the existing field suggestion on the record
        or work-queue inspector. No new queue.
      </p>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.8fr)]">
        <Section title="Product facts" headingAs="h2" compact>
          <Facts
            layout="list"
            facts={[
              { label: "Name", value: "Replacement filter" },
              {
                label: "Compatible model",
                fullWidth: true,
                value: dismissed ? (
                  "Not recorded"
                ) : (
                  <div className="targeted-suggestion">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <Badge
                        variant="outline"
                        className="border-action-change/30 text-action-change"
                      >
                        Suggested change
                      </Badge>
                      <span className="text-xs text-action-change">
                        97% · high confidence
                      </span>
                    </div>
                    <SuggestionReview
                      surface="inline"
                      suggestion={proposal}
                      currentValue={value}
                      questionKey="targeted-preview-model"
                      basis={["Package label"]}
                      onApply={() => setValue("AP-200")}
                      onDismiss={() => setDismissed(true)}
                    >
                      <span>{value ?? "Current: Not recorded"}</span>
                    </SuggestionReview>
                  </div>
                ),
              },
              {
                label: "Subject product",
                value: (
                  <EntityRefLink
                    entity="product"
                    data={{ id: "PRD-2222", name: "Air purifier" }}
                    displayImage={null}
                  />
                ),
              },
              {
                label: "Location",
                value: (
                  <EntityRefLink
                    entity="location"
                    data={{ id: "LOC-2222", name: "Office" }}
                    displayImage={null}
                  />
                ),
              },
            ]}
          />
        </Section>
        <Section
          title="Source evidence"
          headingAs="h2"
          compact
          caption="Package label · attached source"
        >
          <blockquote className="border-l border-border pl-3 text-sm">
            Replacement filter for AP-200 air purifier.
          </blockquote>
          <p className="mt-2 text-xs text-muted-foreground">
            Direct text from a synthetic label. No dimensions or replacement
            interval stated.
          </p>
          <RecordDetail summary="Why this suggestion">
            <p className="text-xs">
              The model appears explicitly on the label. Accepting changes only
              this field.
            </p>
          </RecordDetail>
        </Section>
      </div>
      <output className="text-xs text-muted-foreground">
        {value
          ? "Compatible model updated locally."
          : dismissed
            ? "Suggestion dismissed locally."
            : "Open the suggestion beside Compatible model to review it."}
      </output>
    </div>
  );
}

function ActivityPreview() {
  const [filter, setFilter] = useState<string | null>("all");
  const [older, setOlder] = useState(false);
  return (
    <div className="max-w-5xl space-y-3">
      <PageHeader
        title="Replacement filter"
        layout="inline"
        facts={["Activity", "4 events"]}
      />
      <p className="text-xs text-muted-foreground">
        Tweak: retain RecordList and DateDisplay; put the change on the main
        line and provenance beneath it. Evidence stays behind disclosure.
      </p>
      <Picker
        mode="segmented"
        label="Activity type"
        value={filter}
        onValueChange={setFilter}
        options={[
          { value: "all", label: "All activity" },
          { value: "fields", label: "Changes" },
          { value: "work", label: "Work" },
        ]}
      />
      <RecordList
        variant="timeline"
        aria-label="Record activity"
        className="targeted-activity"
      >
        <RecordHeading label="October 22, 2026" />
        {events
          .filter(
            (x) =>
              x.time.startsWith("2026-10-22") &&
              (filter === "all" || x.work === (filter === "work")),
          )
          .map((event) => (
            <RecordRow
              key={event.time}
              leading={
                <RecordDot
                  color={event.work ? "var(--info)" : "var(--action-change)"}
                  label={event.work ? "Work" : "Change"}
                />
              }
              primary={
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="font-medium">{event.title}</span>
                  {event.change.includes(" → ") ? (
                    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1 text-xs">
                      <span className="text-muted-foreground">
                        {event.change.split(" → ")[0]}
                      </span>
                      <span className="inline-flex items-center gap-1 whitespace-nowrap text-action-change">
                        <ArrowRightIcon
                          aria-hidden
                          className="size-3 shrink-0"
                        />
                        <strong>{event.change.split(" → ")[1]}</strong>
                      </span>
                    </span>
                  ) : event.title === "Product attached to task" ? (
                    <EntityRefLink
                      entity="task"
                      data={{ id: "TSK-2224", name: event.change }}
                      displayImage={null}
                      wrap
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {event.change}
                    </span>
                  )}
                  <span className="basis-full text-xs font-normal text-muted-foreground">
                    {event.source}
                  </span>
                </span>
              }
              trailing={<DateDisplay timestamp={event.time} clock="time" />}
              detail={
                <RecordDetail summary="Evidence">
                  <p className="text-xs">
                    {event.source}. Synthetic stored event; its source remains
                    attached.
                  </p>
                </RecordDetail>
              }
            />
          ))}
        {older && (
          <>
            <RecordHeading label="October 21, 2026" />
            <RecordRow
              leading={<RecordDot tone="muted" label="Attachment" />}
              primary="Source image attached"
              secondary="Package label · manual attachment"
              trailing={
                <DateDisplay
                  timestamp="2026-10-21T15:20:00-07:00"
                  clock="time"
                />
              }
            />
          </>
        )}
      </RecordList>
      {!older && (
        <Button variant="ghost" size="sm" onClick={() => setOlder(true)}>
          Show earlier activity
        </Button>
      )}
    </div>
  );
}

function DueWindowPreview({
  start,
  end,
  onChange,
}: {
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<string | null>(end ? "window" : "single");
  const from = start ? parsePlainDate(start) : undefined;
  const to = end ? parsePlainDate(end) : undefined;
  return (
    <FormFieldGroup
      htmlFor={id}
      label="Due"
      description="One date is a deadline. A range is a due window, not an estimate of time spent."
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id={id}
              variant="outline"
              className="w-full justify-start md:max-w-md"
            />
          }
        >
          {start
            ? `${formatCalendarDay(start, "dateShort")}${end ? ` – ${formatCalendarDay(end, "dateShort")}` : ""}`
            : "Choose due date…"}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-auto max-w-[calc(100vw-2rem)]"
        >
          <Picker
            mode="segmented"
            label="Due selection"
            options={[
              { value: "single", label: "Single date" },
              { value: "window", label: "Date window" },
            ]}
            value={mode}
            onValueChange={(next) => {
              setMode(next);
              if (next === "single") onChange(start, "");
            }}
          />
          {mode === "window" ? (
            <Calendar
              mode="range"
              defaultMonth={from}
              selected={{ from, to }}
              onSelect={(range) =>
                onChange(
                  range?.from ? formatPlainDate(range.from) : "",
                  range?.to ? formatPlainDate(range.to) : "",
                )
              }
            />
          ) : (
            <Calendar
              mode="single"
              defaultMonth={from}
              selected={from}
              onSelect={(date) =>
                onChange(date ? formatPlainDate(date) : "", "")
              }
            />
          )}
          <div className="flex items-center justify-between border-t pt-2">
            <Button variant="ghost" size="sm" onClick={() => onChange("", "")}>
              Clear due date
            </Button>
            <Button size="sm" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </FormFieldGroup>
  );
}
