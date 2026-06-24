import { Check } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { NoneState } from "~/app/_components/NoneState";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { EntityPillLink } from "../EntityPill";

/**
 * Merge confirmation body. Holds its own selected-target state so the radios
 * re-render on click, and mirrors the choice into `targetRef` so a caller that
 * can't read this component's state (e.g. a bulk-action dialog's `onExecute`)
 * picks the right keeper. Shared by the ingredient list's bulk merge and the
 * ingredient-usage table's "merge?" affordance.
 */
export function MergeConfirmation({
  ingredients,
  targetRef,
}: {
  ingredients: Array<{ id: string; name: string }>;
  targetRef: RefObject<string | null>;
}) {
  const [targetId, setTargetId] = useState<string>(
    () => ingredients[0]?.id ?? "",
  );
  useEffect(() => {
    targetRef.current = targetId;
  }, [targetId, targetRef]);

  const aliases = ingredients.filter((i) => i.id !== targetId);
  return (
    <Stack>
      <div>
        <div className="mb-1 font-medium text-muted-foreground text-sm">
          Keep (target):
        </div>
        <div className="flex flex-col gap-1">
          {ingredients.map((ing) => {
            const selected = ing.id === targetId;
            return (
              <Button
                key={ing.id}
                type="button"
                variant={selected ? "default" : "outline"}
                size="sm"
                className="justify-start"
                onClick={() => setTargetId(ing.id)}
              >
                <Check
                  className={cn(
                    "h-4 w-4 shrink-0",
                    selected ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="truncate">{ing.name}</span>
              </Button>
            );
          })}
        </div>
      </div>
      <div>
        <div className="mb-1 font-medium text-muted-foreground text-sm">
          Merge into aliases:
        </div>
        <Row gap="xs" wrap>
          {aliases.length > 0 ? (
            aliases.map((a) => (
              <EntityPillLink
                key={a.id}
                entity="ingredient"
                data={{ name: a.name, id: a.id }}
              />
            ))
          ) : (
            <NoneState />
          )}
        </Row>
      </div>
      <p className="text-muted-foreground text-xs">
        The other selected ingredient{aliases.length === 1 ? "" : "s"} will be
        deleted — their names become aliases of the kept one, and their products
        and recipe uses move over.
      </p>
    </Stack>
  );
}
