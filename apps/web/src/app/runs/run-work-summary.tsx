import type { ActivityRun } from "@cubby/schemas/activity";
import { parseShortcode } from "@cubby/shared";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { isBrowserRoutedEntity } from "~/entity/entities";
import { Row } from "~/ui/layout";

/** The run's subject as a record link with its cover, or its bare name. */
export function RunSubject({ run }: { run: ActivityRun }) {
  const parsed = run.subjectId ? parseShortcode(run.subjectId) : null;
  if (!parsed || !run.subjectId || !isBrowserRoutedEntity(parsed.type))
    return <span className="truncate">{run.subjectName}</span>;
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
