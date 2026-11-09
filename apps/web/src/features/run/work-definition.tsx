import { jobKindDeclaration, JOB_LANE_LABEL } from "@cubby/schemas/job";
import {
  RUN_KINDS,
  runPurpose,
  type RunKindDeclaration,
  type RunStepDeclaration,
} from "@cubby/schemas/run-fields";

import { Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout";
import { Facts } from "~/ui/records/facts";
import { RecordList, RecordRow } from "~/ui/records/record-list";
import { Description } from "~/ui/text/description";

/** The same effects contract is read before launch and alongside actual outcomes. */
export function WorkEffects({
  explanation,
}: {
  explanation: RunKindDeclaration["explanation"];
}) {
  return (
    <Facts
      layout="list"
      facts={[
        { label: "Targets", value: explanation.targets },
        { label: "Excludes", value: explanation.exclusions },
        { label: "Can change", value: explanation.effects },
        { label: "Needs", value: explanation.dependencies },
        { label: "Cost and budget", value: explanation.cost },
        { label: "If it cannot finish", value: explanation.recovery },
      ]}
    />
  );
}

export function StepPurpose({
  purpose,
  scope,
}: {
  purpose: string;
  scope?: string;
}) {
  return (
    <span className="block max-w-prose">
      {purpose}
      {scope ? (
        <span className="block text-muted-foreground">{scope}</span>
      ) : null}
    </span>
  );
}

/** A definition describes possible work, never a fabricated execution state. */
export function DefinedRunSteps({ kind }: { kind: RunKindDeclaration }) {
  return kind.steps ? (
    <RecordList aria-label={`${kind.label} defined steps`}>
      {kind.steps.map((step, index) => (
        <RecordRow
          key={step.key}
          leading={
            <span className="text-muted-foreground tabular-nums">
              {index + 1}.
            </span>
          }
          primary={step.label}
          secondary={<StepPurpose purpose={step.purpose} />}
          clip={false}
          detail={<StepScope step={step} />}
        />
      ))}
    </RecordList>
  ) : (
    <Description>
      The work depends on the selected inputs. Open an actual Run to inspect its
      targets, operations and outcomes; this type has no fixed step sequence.
    </Description>
  );
}

function StepScope({ step }: { step: RunStepDeclaration }) {
  return (
    <p className="max-w-prose text-xs text-muted-foreground">
      {step.scope ? `${step.scope} ` : ""}
      {step.input.mode === "count"
        ? `An exact population is counted when this step starts; later arrivals belong to a later pass. Counts are in ${step.unit}.`
        : step.input.mode === "estimate"
          ? `The provider supplies an estimated number of ${step.unit}; it is not an exact target count.`
          : step.input.reason === "admission"
            ? `Eligible ${step.unit} are discovered during execution. The set can grow; there is no fixed total.`
            : `One bounded operation reports its observed ${step.unit}. No complete target count is known in advance.`}
    </p>
  );
}

export function RunDefinition({ purpose }: { purpose: string }) {
  const parsed = runPurpose.safeParse(purpose);
  if (!parsed.success)
    return (
      <Description>
        This retained Run has no current type definition. Its recorded outcomes
        remain available below.
      </Description>
    );
  const kind: RunKindDeclaration = RUN_KINDS[parsed.data];
  return (
    <Disclosure summary={`What ${kind.label} does`}>
      <Stack gap="md">
        <p className="max-w-prose text-sm">{kind.description}</p>
        <WorkEffects explanation={kind.explanation} />
      </Stack>
    </Disclosure>
  );
}

export function JobDefinition({
  kind,
  defaultOpen = false,
}: {
  kind: string;
  defaultOpen?: boolean;
}) {
  const declaration = jobKindDeclaration(kind);
  if (!declaration)
    return (
      <Description size="xs">
        No current definition for this retained Job kind. Inspect its subject,
        owning Run and recorded diagnostics.
      </Description>
    );
  return (
    <Disclosure
      defaultOpen={defaultOpen}
      summary={`What ${declaration.label} does`}
    >
      <Stack gap="sm">
        <p className="max-w-prose text-sm">{declaration.purpose}</p>
        <WorkEffects
          explanation={{
            ...declaration,
            recovery:
              declaration.maxAttempts === null
                ? "Retries with backoff without exhausting its failure budget. Repeated failures can still need intervention; inspect this Job’s actual state and waiting reason."
                : `Stops after ${declaration.maxAttempts} consecutive failures under the kind’s default policy. Inspect this Job’s actual attempt limit and use supported recovery.`,
          }}
        />
        <p className="text-xs text-muted-foreground">
          Started by: {declaration.trigger} · Executor:{" "}
          {JOB_LANE_LABEL[declaration.lane]}
        </p>
      </Stack>
    </Disclosure>
  );
}
