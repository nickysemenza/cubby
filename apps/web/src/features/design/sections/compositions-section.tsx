import type { FieldSuggestion } from "@cubby/schemas/ai";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
import { Command as CommandPrimitive } from "cmdk";
import { useId, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import {
  QualityResult,
  type RecordQualityCheck,
} from "~/entity/entity-detail/record-quality";
import { SuggestionReview } from "~/entity/suggestions/suggestion-review";
import { Demo, DemoGrid } from "~/features/design/components/design-section";
import { RankedBarBreakdown } from "~/ui/charts/kit";
import { FormWrapper, UnifiedTextField } from "~/ui/forms/form-utils";
import { Section, SectionHeading } from "~/ui/layout";
import { Overlay } from "~/ui/overlays/overlay";
import { Button } from "~/ui/primitives/button";
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/ui/primitives/command";
import { DialogTrigger } from "~/ui/primitives/dialog";
import { Input } from "~/ui/primitives/input";
import {
  Visualization,
  type VisualizationState,
} from "~/ui/visualizations/visualization";

const PROPOSAL: FieldSuggestion = {
  value: "Workshop supplies",
  label: "Workshop supplies",
  confidence: "high",
  probability: 0.97,
  detail: null,
  reasoning: "The synthetic line item is a replacement drill bit.",
  alternatives: [],
  operation: "set",
  removals: [],
};
const DEMO_FAILURE =
  "Synthetic review failure: SQLSTATE 23514 · category_check";

export function ActionWorkflowSection() {
  const [commandOpen, setCommandOpen] = useState(false);
  const [action, setAction] = useState("No action run");
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workflowFormId = useId();
  const workflowForm = useForm({
    defaultValues: { name: "Workshop supplies" },
  });
  const name = useWatch({ control: workflowForm.control, name: "name" });
  return (
    <DemoGrid className="xl:grid-cols-2">
      <Demo
        name="CommandDialog · action search"
        note="Search, then use arrow keys and Enter. Actions update this preview only."
      >
        <Button variant="outline" onClick={() => setCommandOpen(true)}>
          Search demo actions
        </Button>
        <output className="text-xs text-muted-foreground">{action}</output>
        <CommandDialog
          open={commandOpen}
          onOpenChange={setCommandOpen}
          title="Demo actions"
          description="Search local showcase actions."
        >
          <CommandInput
            aria-label="Search demo actions"
            placeholder="Search actions…"
          />
          <CommandList>
            <CommandPrimitive.Empty className="py-4 text-center text-xs text-muted-foreground">
              No demo actions found.
            </CommandPrimitive.Empty>
            <CommandGroup heading="Preview actions">
              {["Review supplies", "Inspect expenses", "Plan maintenance"].map(
                (label) => (
                  <CommandItem
                    key={label}
                    value={label}
                    onSelect={() => {
                      setAction(`${label} selected`);
                      setCommandOpen(false);
                    }}
                  >
                    {label}
                  </CommandItem>
                ),
              )}
            </CommandGroup>
          </CommandList>
        </CommandDialog>
      </Demo>
      <Demo
        name="Overlay · local primary, pending and error"
        note="The first save fails locally. Retry completes the preview."
      >
        <Overlay
          trigger={
            <DialogTrigger
              render={<Button variant="outline">Open demo workflow</Button>}
            />
          }
          open={workflowOpen}
          onOpenChange={(next) => {
            if (pending) return;
            if (next) setError(null);
            setWorkflowOpen(next);
          }}
          title="Review supplies for the workshop maintenance project"
          description="A synthetic workflow; no record is written."
          summary="1 category"
          error={error}
          bodyMode="form"
          pending={pending}
          primary={{
            label: error ? "Retry preview" : "Save preview",
            pendingLabel: "Saving preview…",
            form: workflowFormId,
            disabled: !name.trim(),
          }}
        >
          <FormWrapper
            form={workflowForm}
            id={workflowFormId}
            hideActions
            footerMode="dialog"
            isPending={pending}
            onSubmittingChange={setPending}
            submitButtonText="Save preview"
            onSubmit={async ({ name }) => {
              await new Promise((resolve) => setTimeout(resolve, 1000));
              if (!error)
                setError(
                  "Synthetic workflow failure: SQLSTATE 23514 · category_check",
                );
              else {
                setWorkflowOpen(false);
                setAction(`Preview saved: ${name}`);
              }
            }}
          >
            <UnifiedTextField
              form={workflowForm}
              name="name"
              label="Category name"
              placeholder="Workshop supplies"
            />
          </FormWrapper>
        </Overlay>
      </Demo>
      <OverlayOverflowDemo />
    </DemoGrid>
  );
}

function OverlayOverflowDemo() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const form = useForm({
    defaultValues: { name: "Synthetic workshop supplies" },
  });
  return (
    <Demo
      name="Overlay · long labels and diagnostics"
      note="Long actions wrap; fields and raw diagnostics scroll independently."
    >
      <Overlay
        open={open}
        onOpenChange={setOpen}
        trigger={
          <DialogTrigger
            render={<Button variant="outline">Open long-label workflow</Button>}
          />
        }
        title="Review replacement supplies for the workshop maintenance project"
        cancelLabel="Cancel supply review"
        primary={{
          label: "Save all replacement supply descriptions",
          form: formId,
        }}
        bodyMode="form"
        pending={pending}
        error={error}
      >
        <FormWrapper
          form={form}
          id={formId}
          hideActions
          footerMode="dialog"
          isPending={pending}
          onSubmittingChange={setPending}
          submitButtonText="Save all replacement supply descriptions"
          onSubmit={() =>
            setError(
              `SQLSTATE 23514: synthetic_supply_check ${"synthetic_detail_".repeat(400)}`,
            )
          }
        >
          <UnifiedTextField
            form={form}
            name="name"
            label="Supply description"
            placeholder="Supply description"
          />
          {Array.from({ length: 24 }, (_, index) => (
            <p key={`supply-${index}`} className="border-b py-2 text-xs">
              Synthetic supply detail {index + 1}
            </p>
          ))}
        </FormWrapper>
      </Overlay>
    </Demo>
  );
}

function ReviewDemo({
  surface,
  fail,
}: {
  surface: "inline" | "cell";
  fail?: boolean;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [result, setResult] = useState("Awaiting review");
  const [version, setVersion] = useState(0);
  return (
    <div className="space-y-2">
      <div
        className={
          surface === "cell"
            ? "w-56 max-w-full border px-2 py-1 text-xs"
            : undefined
        }
      >
        <SuggestionReview
          key={version}
          surface={surface}
          suggestion={PROPOSAL}
          currentValue={value}
          questionKey={`design-${surface}-${fail ? "failure" : "review"}`}
          basis={["Line item"]}
          onApply={() => {
            if (fail) throw new Error(DEMO_FAILURE);
            setValue(PROPOSAL.value);
            setResult("Accepted locally");
          }}
          onDismiss={() => setResult("Rejected locally")}
        >
          <span>{value ?? "Uncategorized"}</span>
        </SuggestionReview>
      </div>
      <output className="text-xs text-muted-foreground">{result}</output>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setValue(null);
          setResult("Awaiting review");
          setVersion(version + 1);
        }}
      >
        Reset {surface} {fail ? "failure" : "review"}
      </Button>
    </div>
  );
}

export function SuggestionReviewSection() {
  return (
    <Section description="Shared review behavior, with local acceptance and rejection. Failure examples retain raw synthetic diagnostics and remain retryable.">
      <DemoGrid className="xl:grid-cols-2">
        <Demo name="SuggestionReview · inline">
          <ReviewDemo surface="inline" />
        </Demo>
        <Demo name="SuggestionReview · cell">
          <ReviewDemo surface="cell" />
        </Demo>
        <Demo name="SuggestionReview · inline apply failure">
          <ReviewDemo surface="inline" fail />
        </Demo>
        <Demo name="SuggestionReview · cell apply failure">
          <ReviewDemo surface="cell" fail />
        </Demo>
      </DemoGrid>
    </Section>
  );
}

export function SectionCompositionsSection() {
  const [draft, setDraft] = useState("Check workshop shelf");
  const [count, setCount] = useState(2);
  return (
    <DemoGrid className="xl:grid-cols-2">
      <Demo name="Section · headings, actions and deferred context">
        <SectionHeading
          as="h3"
          title="Current work"
          meta={
            <span className="text-xs text-muted-foreground">{count} tasks</span>
          }
          actions={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCount(count + 1)}
            >
              Add demo task
            </Button>
          }
        />
        <Section
          headingAs="h3"
          title="Workshop tasks"
          icon={<ListBulletsIcon />}
          description="Synthetic household work"
        >
          <p>{count} tasks awaiting review</p>
        </Section>
        <Section
          aria-label="Household context demo"
          title="Explore household context"
          meta={"Optional detail"}
          disclosure={{}}
          actions={
            <Button size="sm" variant="ghost" onClick={() => setCount(2)}>
              Reset demo task count
            </Button>
          }
        >
          <p className="text-xs">
            The workshop shelf has space for spare parts.
          </p>
        </Section>
      </Demo>
      <Demo
        name="Section · owner-held draft"
        note="Collapse and reopen Notes: the draft belongs to the form owner."
      >
        <Section headingAs="h4" title="Task details">
          <p className="text-xs">Workshop shelf inspection</p>
        </Section>
        <Section headingAs="h4" title="Notes" disclosure={{}}>
          <label
            htmlFor="design-task-note"
            className="flex flex-col gap-1 text-xs"
          >
            Task note
            <Input
              id="design-task-note"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
        </Section>
      </Demo>
    </DemoGrid>
  );
}

const QUALITY_CHECKS: RecordQualityCheck[] = [
  {
    check: "design.name",
    label: "Name present",
    facet: "identity",
    kind: "missing",
    weight: 1,
    scoreCap: 100,
    state: "satisfied",
    stateLabel: "Satisfied",
    weightLabel: "weight 1",
    description: "A name is recorded.",
    exceptionReasons: [],
  },
  {
    check: "design.category",
    label: "Category missing",
    facet: "classification",
    kind: "missing",
    weight: 1,
    scoreCap: 100,
    state: "gap",
    stateLabel: "Missing data",
    weightLabel: "weight 1",
    description: "Choose a category.",
    exceptionReasons: [],
  },
  {
    check: "design.amount",
    label: "Amount mismatch",
    facet: "amount",
    kind: "defect",
    weight: 1,
    scoreCap: 60,
    state: "gap",
    stateLabel: "Defect",
    weightLabel: "weight 1 · caps at 60 while unresolved",
    description: "The synthetic totals differ.",
    exceptionReasons: [],
  },
  {
    check: "design.picture",
    label: "Picture unavailable",
    facet: "images",
    kind: "missing",
    weight: 1,
    scoreCap: 100,
    state: "excepted",
    stateLabel: "Accepted exception",
    weightLabel: "weight 1",
    description: "An exception has been recorded.",
    exceptionReasons: [],
  },
];
const SIGNED_VALUES = [
  { label: "Supplies", amount: 120 },
  { label: "Refund", amount: -45 },
  { label: "Parts", amount: 30 },
];

function VisualizationDemo() {
  const [state, setState] = useState<VisualizationState>({ status: "ready" });
  const retry = () => setState({ status: "ready" });
  const failure = new Error(
    "Synthetic visualization read: SQLSTATE 08006 · SELECT amount FROM demo_expense",
  );
  return (
    <Demo
      name="Visualization · query lifecycle"
      note="Select a bar, then fail refresh: selection stays mounted. Initial load and new scope discard the renderer. Retry recovers locally."
    >
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => setState({ status: "loading" })}
        >
          First load / new scope
        </Button>
        <Button variant="outline" onClick={() => setState({ status: "empty" })}>
          Empty
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            setState({ status: "error", error: failure, onRetry: retry })
          }
        >
          Initial error
        </Button>
        <Button variant="outline" onClick={retry}>
          Ready
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            setState({ status: "ready", refreshError: failure, onRetry: retry })
          }
        >
          Fail refresh
        </Button>
      </div>
      <Visualization
        title="Synthetic spend"
        state={state}
        message="No demo expenses."
        height={100}
      >
        <SelectableDemoBars />
      </Visualization>
    </Demo>
  );
}

function SelectableDemoBars() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <RankedBarBreakdown
        data={[
          { key: "supplies", label: "Supplies", value: 42 },
          { key: "credit", label: "Credit", value: -12 },
        ]}
        valueKey="value"
        labelKey="label"
        idKey="key"
        onClick={(row) => setSelected(row.label)}
        formatValue={(value) => `$${value}`}
        emptyTitle="No demo expenses."
      />
      <Button
        variant="outline"
        aria-pressed={selected !== null}
        onClick={() => setSelected(selected ? null : "Supplies")}
      >
        {selected ? `Clear ${selected} selection` : "Select Supplies"}
      </Button>
    </div>
  );
}

export function QualityChartsSection() {
  return (
    <Section>
      <VisualizationDemo />
      <Demo name="QualityResult · record check states">
        <div className="grid gap-2 sm:grid-cols-2">
          {QUALITY_CHECKS.map((check) => (
            <QualityResult key={check.check} check={check} />
          ))}
        </div>
      </Demo>
      <DemoGrid className="xl:grid-cols-2">
        <Demo
          name="RankedBarBreakdown · signed values"
          note="Supplies $120 · refund −$45 · parts $30. Bars rank by absolute value."
        >
          <RankedBarBreakdown
            data={SIGNED_VALUES}
            valueKey="amount"
            labelKey="label"
            height={220}
            margin={{ top: 10, right: 25, bottom: 40, left: 75 }}
            summary="Synthetic expenses: supplies 120 dollars, refund minus 45 dollars, parts 30 dollars"
            emptyTitle="No demo expenses"
          />
        </Demo>
        <Demo name="RankedBarBreakdown · empty">
          <RankedBarBreakdown
            data={[]}
            valueKey="amount"
            labelKey="label"
            emptyTitle="No demo expenses"
          />
        </Demo>
      </DemoGrid>
    </Section>
  );
}
