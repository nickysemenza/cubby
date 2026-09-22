import { auditEntitySchema } from "@cubby/schemas/audit";
import type { Entity } from "@cubby/schemas/entity";
import { fieldExplanationSource } from "@cubby/schemas/field-explanation";
import { inventoryShortcode } from "@cubby/schemas/identifiers";
import { parseShortcode } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import { EntityInlineLinkById } from "~/app/_components/EntityInlineLinkById";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { inventory } from "~/app/inventory/inventory.functions";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { formatCurrency } from "~/lib/utils";

import { fieldExplanation } from "./field-explanation.functions";

type ExplanationSource = z.infer<typeof fieldExplanationSource>;
type ExplanationValue = ExplanationSource["value"];
const explanationScalar = z.union([z.string(), z.number(), z.boolean()]);
const explanationRecord = z.record(z.string(), z.json());

const humanizeKey = (key: string) =>
  key
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());

function ReadableExplanationValue({
  value,
  depth = 0,
  property,
}: {
  value: ExplanationValue;
  depth?: number;
  property?: string;
}) {
  if (value === null) return <NoneValue />;
  const textValue = z.string().safeParse(value);
  const reference = textValue.success ? parseShortcode(textValue.data) : null;
  if (reference)
    return (
      <ExplanationEntityLink entity={reference.type} id={reference.shortcode} />
    );
  const amount = property === "amount" ? z.number().safeParse(value) : null;
  if (amount?.success)
    return (
      <span className="font-mono tabular-nums">
        {formatCurrency(amount.data)}
      </span>
    );
  const scalar = explanationScalar.safeParse(value);
  if (scalar.success) {
    const boolean = z.boolean().safeParse(scalar.data);
    const display = boolean.success
      ? boolean.data
        ? "Yes"
        : "No"
      : scalar.data;
    return <span className="break-words">{display}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <NoneValue />;
    const occurrences = new Map<string, number>();
    return (
      <ul className="grid gap-1 pl-4 text-xs">
        {value.map((item) => {
          const contentKey = JSON.stringify(item);
          const occurrence = occurrences.get(contentKey) ?? 0;
          occurrences.set(contentKey, occurrence + 1);
          return (
            <li key={`${contentKey}:${occurrence}`} className="list-disc">
              <ReadableExplanationValue value={item} depth={depth + 1} />
            </li>
          );
        })}
      </ul>
    );
  }
  const record = explanationRecord.safeParse(value);
  if (!record.success) return <span>Unavailable</span>;
  if (depth >= 2) {
    const summary = Object.entries(record.data)
      .filter(([, item]) => explanationScalar.safeParse(item).success)
      .slice(0, 3)
      .map(([key, item]) => `${humanizeKey(key)}: ${String(item)}`)
      .join(" · ");
    return <span>{summary || "Supporting details"}</span>;
  }
  return (
    <dl className="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
      {Object.entries(record.data).map(([key, item]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{humanizeKey(key)}</dt>
          <dd className="min-w-0">
            <ReadableExplanationValue
              value={item}
              depth={depth + 1}
              property={key}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}

const explanationSourceKey = (source: ExplanationSource): string =>
  [
    source.label,
    source.entity?.entityType ?? "value",
    source.entity?.entityId ?? JSON.stringify(source.value),
  ].join(":");

function ExplanationEntityLink({ entity, id }: { entity: Entity; id: string }) {
  const auditable = auditEntitySchema.safeParse(entity);
  return auditable.success ? (
    <EntityInlineLinkById entityType={auditable.data} entityId={id} />
  ) : (
    <span className="font-mono text-xs">{id}</span>
  );
}

export function FieldExplanation({
  entity,
  id,
  field,
  label,
  surface = "detail",
}: {
  entity: Entity;
  id: string;
  field: string;
  label: string;
  surface?: "list" | "detail" | "summary";
}) {
  const [open, setOpen] = useState(false);
  const inheritOwner = useActionMutation({
    mutationFn: inventory.setOwnership.mutationOptions,
    success: "Using inherited owner",
  });
  const confirmOwner = useActionMutation({
    mutationFn: inventory.confirmOwnership.mutationOptions,
    success: "Owner confirmed",
  });
  const result = useQuery({
    ...fieldExplanation.explain.queryOptions({
      entityType: entity,
      entityId: id,
      field,
      surface,
    }),
    enabled: open,
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`How ${label.toLowerCase()} is determined`}
          />
        }
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent className="max-h-[min(32rem,80dvh)] w-80 overflow-y-auto">
        <Stack gap="sm">
          <PopoverTitle>How {label.toLowerCase()} is determined</PopoverTitle>
          {result.isPending ? (
            <p>Loading explanation…</p>
          ) : result.isError ? (
            <Stack gap="sm">
              <ErrorDisplay error={result.error} title="this explanation" />
              <Button
                size="sm"
                variant="outline"
                onClick={() => void result.refetch()}
                disabled={result.isFetching}
              >
                Retry explanation
              </Button>
            </Stack>
          ) : (
            <>
              <p className="text-sm">{result.data.rule.description}</p>
              {result.data.value !== null ||
              !result.data.sources.some(
                (source) =>
                  source.label === "Project share" ||
                  source.label === "Unassigned share",
              ) ? (
                <div className="text-sm">
                  <span className="text-muted-foreground">Current value</span>
                  <div className="mt-1">
                    <ReadableExplanationValue value={result.data.value} />
                  </div>
                </div>
              ) : null}
              {result.data.sources.map((source) => (
                <div
                  key={explanationSourceKey(source)}
                  className="grid gap-1 text-sm"
                >
                  <span className="text-muted-foreground">{source.label}</span>
                  {source.entity ? (
                    <ExplanationEntityLink
                      entity={source.entity.entityType}
                      id={source.entity.entityId}
                    />
                  ) : null}
                  {source.value !== null || source.entity === null ? (
                    <div className="mt-1">
                      <ReadableExplanationValue value={source.value} />
                    </div>
                  ) : null}
                </div>
              ))}
              {result.data.truncated ? (
                <p className="text-xs text-muted-foreground">
                  Showing the first sources.
                </p>
              ) : null}
              {result.data.actions.map((action) => {
                const inventoryAction =
                  action.target.entityType === "inventory";
                if (action.kind === "inheritOwner" && inventoryAction) {
                  return (
                    <Button
                      key={action.kind}
                      size="sm"
                      variant="outline"
                      disabled={inheritOwner.isPending}
                      onClick={() =>
                        inheritOwner.mutate({
                          inventoryEntryId: inventoryShortcode.parse(
                            action.target.entityId,
                          ),
                          ownership: { mode: "inherit" },
                        })
                      }
                    >
                      {action.label}
                    </Button>
                  );
                }
                if (
                  action.kind === "confirmOwner" &&
                  inventoryAction &&
                  result.data.evidenceFingerprint
                ) {
                  const evidenceFingerprint = result.data.evidenceFingerprint;
                  return (
                    <Button
                      key={action.kind}
                      size="sm"
                      variant="outline"
                      disabled={confirmOwner.isPending}
                      onClick={() =>
                        confirmOwner.mutate({
                          inventoryEntryId: inventoryShortcode.parse(
                            action.target.entityId,
                          ),
                          evidenceFingerprint,
                        })
                      }
                    >
                      {action.label}
                    </Button>
                  );
                }
                return (
                  <div
                    key={action.kind}
                    className="flex items-center gap-2 text-sm"
                  >
                    <span>{action.label}</span>
                    <ExplanationEntityLink
                      entity={action.target.entityType}
                      id={action.target.entityId}
                    />
                  </div>
                );
              })}
            </>
          )}
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
