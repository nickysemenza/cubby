import {
  type RunKindDeclaration,
  type RunStepDeclaration,
} from "@cubby/schemas/run-fields";

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
