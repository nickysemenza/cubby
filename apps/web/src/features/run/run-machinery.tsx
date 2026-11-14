import {
  kernelStageLabel,
  machineryCostLabel,
} from "@cubby/schemas/field-envelope-presentation";
import { kernelStage } from "@cubby/schemas/kernel/stage";
import { useQuery } from "@tanstack/react-query";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { machinery } from "~/integrations/tanstack-query/generated/domains/machinery.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Disclosure } from "~/ui/layout";
import { Skeleton } from "~/ui/primitives/skeleton";

/** The Run workspace's scopes, asks and passes from one kernel snapshot. */
export function RunMachinery({ record }: { record: DetailRecordOf<"run"> }) {
  const read = useQuery(machinery.runWork.queryOptions({ runId: record.id }));
  if (read.isPending) return <Skeleton className="h-24 w-full" />;
  if (read.isError)
    return (
      <ErrorDisplay
        error={read.error}
        title="this Run's work"
        onRetry={() => void read.refetch()}
      />
    );
  const work = read.data;
  const rows = [
    ...work.scopes.map((scope) => ({
      key: `scope:${scope.kind}:${scope.key}`,
      label: scope.label,
      stage: scope.stage,
      detail: scope,
      record: scope.record,
    })),
    ...work.asks.map((ask) => ({
      key: `ask:${ask.inputHash}`,
      label: ask.label,
      stage: ask.stage,
      detail: ask,
      record: ask.record,
    })),
    ...work.passes.map((pass) => ({
      key: `pass:${pass.name}:${pass.key}`,
      label: pass.label,
      stage: pass.stage,
      detail: pass,
      record: { entity: "run" as const, id: record.id },
    })),
  ];
  return (
    <div className="grid min-w-0 gap-3 text-sm break-words">
      <p className="tabular-nums">
        {work.scopes.length} scopes · {work.asks.length} asks ·{" "}
        {work.passes.length} passes · {machineryCostLabel(work.totalCostMicros)}
      </p>
      {!rows.length ? (
        <p>Cubby has recorded no work for this Run yet.</p>
      ) : null}
      {kernelStage.options.map((stage) => {
        const group = rows.filter((row) => row.stage === stage);
        return group.length ? (
          <section
            key={stage}
            aria-label={kernelStageLabel(stage)}
            className="grid min-w-0 gap-1"
          >
            <h3 className="font-medium tabular-nums">
              {kernelStageLabel(stage)} · {group.length}
            </h3>
            <ul>
              {group.map((row) => (
                <li
                  key={row.key}
                  className="min-w-0 border-b border-border py-2"
                >
                  {row.record ? (
                    <EntityRefLink
                      entity={row.record.entity}
                      id={row.record.id}
                    />
                  ) : null}
                  <Disclosure summary={row.label}>
                    <p>Attempts: {row.detail.attempts}</p>
                    <p>Cost: {machineryCostLabel(row.detail.costMicros)}</p>
                    {row.detail.lastError ? (
                      <pre className="text-xs break-words whitespace-pre-wrap">
                        {row.detail.lastError}
                      </pre>
                    ) : null}
                  </Disclosure>
                </li>
              ))}
            </ul>
          </section>
        ) : null;
      })}
    </div>
  );
}
