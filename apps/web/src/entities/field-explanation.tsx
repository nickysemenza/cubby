import { auditEntitySchema } from "@cubby/schemas/audit";
import type { Entity } from "@cubby/schemas/entity";
import { fieldExplanationSource } from "@cubby/schemas/field-explanation";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import { EntityInlineLinkById } from "~/app/_components/EntityInlineLinkById";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";

import { fieldExplanation } from "./field-explanation.functions";

type ExplanationSource = z.infer<typeof fieldExplanationSource>;
type ExplanationValue = ExplanationSource["value"];
const explanationString = z.string();

const formatExplanationValue = (value: ExplanationValue): string => {
  const text = explanationString.safeParse(value);
  return text.success ? text.data : JSON.stringify(value, null, 2);
};

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
      <PopoverContent className="w-80">
        <Stack gap="sm">
          <PopoverTitle>How {label.toLowerCase()} is determined</PopoverTitle>
          {result.isPending ? (
            <p>Loading explanation…</p>
          ) : result.isError ? (
            <p role="alert">
              Could not load this explanation. Close and reopen to retry.
            </p>
          ) : (
            <>
              <p className="text-sm">{result.data.rule.description}</p>
              <div className="text-sm">
                <span className="text-muted-foreground">Current value</span>
                <pre className="text-xs break-words whitespace-pre-wrap">
                  {formatExplanationValue(result.data.value)}
                </pre>
              </div>
              {result.data.sources.map((source) => (
                <div key={explanationSourceKey(source)} className="text-sm">
                  <span className="text-muted-foreground">{source.label}</span>
                  {source.entity ? (
                    <ExplanationEntityLink
                      entity={source.entity.entityType}
                      id={source.entity.entityId}
                    />
                  ) : null}
                  {source.value !== null ? (
                    <pre className="text-xs break-words whitespace-pre-wrap">
                      {formatExplanationValue(source.value)}
                    </pre>
                  ) : null}
                </div>
              ))}
              {result.data.truncated ? (
                <p className="text-xs text-muted-foreground">
                  Showing the first sources.
                </p>
              ) : null}
              {result.data.actions.map((action) => (
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
              ))}
            </>
          )}
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
