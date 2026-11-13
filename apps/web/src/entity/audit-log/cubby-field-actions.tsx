import type { AuditLogListOut } from "@cubby/schemas/audit";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { fieldAuthorityActionInput } from "@cubby/schemas/field-authority";
import { suggestApplyPolicy } from "@cubby/schemas/field-suggestion-policy";
import { useMutation } from "@tanstack/react-query";

import { suggestion } from "~/integrations/tanstack-query/generated/domains/suggestion.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Button } from "~/ui/primitives/button";

/** Audited Cubby values are confirmed or vetoed through the assignment policy. */
export function CubbyFieldActions({
  entry,
}: {
  entry: AuditLogListOut["entries"][number];
}) {
  const write = useMutation(suggestion.fieldAuthority.mutationOptions());
  const entity = fieldAuthorityActionInput.shape.entity.safeParse(
    entry.entityKind,
  );
  if (
    !entity.success ||
    !entry.entityId ||
    entry.provenance?.scope.kind !== "fields"
  )
    return null;
  const fields = entityFieldModels[entity.data].fields.filter(
    (field) =>
      field.control?.suggest &&
      suggestApplyPolicy(entity.data, field.key) === "auto" &&
      entry.changes?.[field.key]?.to != null,
  );
  return (
    <div className="grid gap-1 border-b border-border py-1">
      {fields.map((field) => (
        <div
          key={field.key}
          className="flex flex-wrap items-center gap-2 text-xs"
        >
          <span>{field.label}</span>
          {(["keep", "clear"] as const).map((action) => (
            <Button
              key={action}
              size="xs"
              variant="ghost"
              disabled={write.isPending || write.isSuccess}
              onClick={() =>
                write.mutate({
                  entity: entity.data,
                  id: entry.entityId!,
                  field: field.key,
                  action,
                  suggestionId: entry.entryKey,
                })
              }
            >
              {action === "keep" ? "Keep" : "Wrong, clear it"}
            </Button>
          ))}
        </div>
      ))}
      <output className="text-xs">
        {write.isSuccess ? "Decision recorded." : null}
      </output>
      {write.error ? (
        <ErrorDisplay error={write.error} title="this change" />
      ) : null}
    </div>
  );
}
