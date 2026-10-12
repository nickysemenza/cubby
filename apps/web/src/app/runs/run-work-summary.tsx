import type { ActivityRun } from "@cubby/schemas/activity";
import { parseShortcode } from "@cubby/shared";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { EntityIcon, isBrowserRoutedEntity } from "~/entity/entities";
import { Ledger, LedgerCell, LedgerRow } from "~/ui/common/ledger";
import { Row } from "~/ui/layout";

/** The run's subject as a record link with its cover, or its bare name. */
export function RunSubject({ run }: { run: ActivityRun }) {
  const parsed = run.subjectId ? parseShortcode(run.subjectId) : null;
  if (!parsed || !run.subjectId || !isBrowserRoutedEntity(parsed.type))
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <EntityIcon
          entity={run.iconEntity}
          size={14}
          colored
          aria-hidden="true"
        />
        <span className="truncate">{run.subjectName}</span>
      </span>
    );
  return (
    <EntityRefLink
      variant="chip"
      entity={parsed.type}
      id={run.subjectId}
      name={run.subjectName}
      displayImage={run.subjectImage}
    />
  );
}

/** The first targets as linked chips, then how many more the run holds. */
export function RunTargetChips({
  run,
  wrap = false,
}: {
  run: ActivityRun;
  wrap?: boolean;
}) {
  if (run.targetPreview.length === 0) return null;
  const more = (run.targetCounts?.total ?? 0) - run.targetPreview.length;
  return (
    <Row gap="xs" align="center" wrap={wrap} className="min-w-0">
      {run.targetPreview.map((target) =>
        isBrowserRoutedEntity(target.entity) ? (
          <EntityRefLink
            key={target.id}
            variant="chip"
            entity={target.entity}
            id={target.id}
            name={target.name}
            displayImage={target.displayImage}
            wrap={wrap}
          />
        ) : (
          <span key={target.id} className="font-mono text-xs">
            {target.id}
          </span>
        ),
      )}
      {more > 0 ? (
        <span className="shrink-0 text-xs text-muted-foreground">+{more}</span>
      ) : null}
    </Row>
  );
}

/** What the work is about, how far it got, and which records it touched. */
export function RunWorkFacts({ run }: { run: ActivityRun }) {
  const outcome = run.targetSummary;
  return (
    <Ledger as="dl" variant="facts" className="mb-3">
      <LedgerRow as="div">
        <LedgerCell as="dt" slot="primary" className="text-muted-foreground">
          Subject
        </LedgerCell>
        <LedgerCell as="dd" slot="secondary">
          <RunSubject run={run} />
        </LedgerCell>
      </LedgerRow>
      {run.currentStep ? (
        <LedgerRow as="div">
          <LedgerCell as="dt" slot="primary" className="text-muted-foreground">
            {run.active ? "Now" : "Last step"}
          </LedgerCell>
          <LedgerCell as="dd" slot="secondary">
            {run.currentStep}
          </LedgerCell>
        </LedgerRow>
      ) : null}
      {outcome ? (
        <LedgerRow as="div">
          <LedgerCell as="dt" slot="primary" className="text-muted-foreground">
            Targets
          </LedgerCell>
          <LedgerCell as="dd" slot="secondary" className="grid gap-1">
            <span className="tabular-nums">{outcome}</span>
            <RunTargetChips run={run} wrap />
          </LedgerCell>
        </LedgerRow>
      ) : null}
      {run.recordType === "run" ? (
        <LedgerRow as="div">
          <LedgerCell as="dt" slot="primary" className="text-muted-foreground">
            Changed
          </LedgerCell>
          <LedgerCell as="dd" slot="secondary" className="tabular-nums">
            {run.changedCount === 1
              ? "1 record"
              : `${run.changedCount} records`}
          </LedgerCell>
        </LedgerRow>
      ) : null}
    </Ledger>
  );
}
