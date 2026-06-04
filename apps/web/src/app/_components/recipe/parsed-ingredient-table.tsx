import { AlertCircle, Plus } from "lucide-react";
import { useMemo } from "react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import { EntityPillLink } from "../EntityPill";
import { formatAmounts } from "../inventory/format-amount";
import type { IngredientMatchMap } from "./use-ingredient-matches";

/**
 * Compact parsed-ingredient table shared by the cookbook importer and (optionally)
 * the recipe form: each line is parsed with WASM and shown as name / amount /
 * modifier, with matched ingredients rendered as a green pill link and unmatched
 * ones flagged. `matchMap` comes from {@link useIngredientMatches} (one batched
 * lookup); when `onCreate` is given, unmatched rows get a "+" to create the
 * ingredient (recipe-form behavior); otherwise they read "· new" (cookbook
 * import, which find-or-creates on import).
 */
export function ParsedIngredientTable({
  lines,
  matchMap,
  matchReady,
  onCreate,
}: {
  lines: string[];
  matchMap: IngredientMatchMap;
  matchReady: boolean;
  onCreate?: (name: string) => void;
}) {
  const rows = useMemo(
    () => lines.map((line) => ({ line, parsed: wasm.parse_ingredient(line) })),
    [lines],
  );
  if (rows.length === 0) return null;
  return (
    <table className="w-full border-collapse text-xs">
      <tbody>
        {rows.map(({ line, parsed }, i) => {
          const name = parsed.name || line;
          const match = parsed.name
            ? matchMap.get(parsed.name.toLowerCase())
            : null;
          const isNew = matchReady && !match;
          return (
            <tr
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed ordered list
              key={i}
              className={cn(
                "border-border/40 border-b last:border-0",
                match && "bg-green-50/40",
                isNew && "bg-amber-50/30",
              )}
            >
              <td className="py-0.5 pr-2 align-top">
                {match ? (
                  <EntityPillLink entity="ingredient" data={match} />
                ) : (
                  <span className="flex items-center gap-1">
                    {isNew && (
                      <AlertCircle className="h-3 w-3 shrink-0 text-amber-600" />
                    )}
                    <span className={isNew ? "text-amber-700" : ""}>
                      {name}
                    </span>
                    {isNew && onCreate ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0 text-amber-600 hover:bg-amber-100 hover:text-amber-700"
                        onClick={() => onCreate(parsed.name)}
                        title="Add to your library"
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    ) : (
                      isNew && (
                        <span
                          className="text-amber-600"
                          title="Will be created on import"
                        >
                          · new
                        </span>
                      )
                    )}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap py-0.5 pr-2 align-top text-muted-foreground">
                {parsed.amounts.length > 0 ? formatAmounts(parsed.amounts) : ""}
              </td>
              <td className="py-0.5 align-top text-muted-foreground">
                {parsed.modifier ?? ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
