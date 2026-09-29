import type { RecipeUsage } from "@cubby/schemas/recipe";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useMemo, useState } from "react";

import { EntityRefLink } from "~/components/entity/entity-ref-link";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  computeParseDrift,
  hasDrift,
  type ParseDrift,
} from "~/lib/parse-drift";
import { wasm } from "~/lib/wasm";

import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "../entity-media/entity-display-images";
import { formatAmounts } from "../inventory/format-amount";
import { DriftIndicator } from "../parse-drift-indicator";

export type UsageRow = RecipeUsage & {
  // Re-parsing the stored raw line with the *current* parser, compared field-by-field
  // against what's persisted. Non-null fields are stale and would change on re-parse.
  drift: ParseDrift;
};

/**
 * Per-usage table for the "Appears In Recipes" section on the ingredient and
 * product detail pages. One row per {@link RecipeUsage} (a recipe repeats when it
 * uses the ingredient in multiple sections), showing the formatted amount,
 * modifier, and the original imported line. Re-parses each raw line with the
 * current parser and surfaces (read-only) any drift — name (Source line), amounts
 * (Amount), or modifier — via {@link computeParseDrift}. `ingredientName`/`aliases`
 * are the name(s) the drift check matches against; for products this is the
 * product's linked ingredient.
 */
export function RecipeUsagesTable({
  usages,
  ingredientName,
  aliases,
  onReparse,
}: {
  usages: RecipeUsage[];
  ingredientName: string;
  aliases?: string[];
  /**
   * Offers a per-usage "Re-parse" on a drifted line, applying its fresh parse.
   * Omitted, drift stays read-only.
   */
  onReparse?: (usage: UsageRow) => Promise<void>;
}) {
  const [reparsingId, setReparsingId] = useState<string | null>(null);
  const rows = useMemo<UsageRow[]>(() => {
    const knownNames = [ingredientName, ...(aliases ?? [])];
    // One batch WASM call for the whole table instead of one per row — output
    // order matches input (parse_ingredient_lines contract), so indexing by
    // position below is safe. Rows without a rawLine feed "" through the
    // batch call too (harmless — the result is only read when rawLine is
    // truthy) rather than reshuffling indices for a sparse subset.
    const parsedLines = wasm.parse_ingredient_lines(
      usages.map((usage) => usage.rawLine ?? ""),
    );
    return usages
      .map((usage, i) => {
        let drift: ParseDrift = { name: null, amounts: null, modifier: null };
        if (usage.rawLine) {
          const fresh = parsedLines[i]!;
          drift = computeParseDrift(
            {
              knownNames,
              amounts: usage.amounts,
              modifier: usage.modifier ?? null,
            },
            fresh,
          );
        }
        return { ...usage, drift };
      })
      .sort(
        (a, b) =>
          a.recipe.name.localeCompare(b.recipe.name) ||
          (a.sectionName ?? "").localeCompare(b.sectionName ?? ""),
      );
  }, [usages, ingredientName, aliases]);
  const imageRefs = useMemo(
    () =>
      rows.map((row) => ({
        entityKind: "recipe" as const,
        entityId: row.recipe.id,
      })),
    [rows],
  );
  const displayImages = useEntityDisplayImages(imageRefs);

  if (rows.length === 0) return null;

  return (
    <Table className="table-auto">
      <TableHeader>
        <TableRow>
          <TableHead>Recipe</TableHead>
          <TableHead>Section</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead>Modifier</TableHead>
          <TableHead>Source line</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="align-top">
              <EntityRefLink
                displayImage={
                  displayImages[
                    entityDisplayImageKey({
                      entityKind: "recipe",
                      entityId: row.recipe.id,
                    })
                  ] ?? null
                }
                entity="recipe"
                data={row.recipe}
              />
            </TableCell>
            <TableCell className="align-top text-muted-foreground">
              {row.sectionName ?? ""}
            </TableCell>
            <TableCell className="align-top text-muted-foreground">
              {row.drift.amounts !== null ? (
                <DriftIndicator
                  axis="amount"
                  before={formatAmounts(row.amounts)}
                  after={formatAmounts(row.drift.amounts)}
                  className="max-w-[12rem]"
                />
              ) : row.amounts.length > 0 ? (
                formatAmounts(row.amounts)
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex items-center gap-1 text-warning" />
                    }
                  >
                    <WarningCircleIcon className="size-3 shrink-0 text-warning" />
                    —
                  </TooltipTrigger>
                  <TooltipContent>No parsed amount</TooltipContent>
                </Tooltip>
              )}
            </TableCell>
            <TableCell className="align-top whitespace-normal text-muted-foreground">
              {row.drift.modifier !== null ? (
                <DriftIndicator
                  axis="modifier"
                  before={row.modifier ?? ""}
                  after={row.drift.modifier}
                  className="max-w-[18rem]"
                />
              ) : (
                (row.modifier ?? "")
              )}
            </TableCell>
            <TableCell className="align-top whitespace-normal">
              {row.rawLine ? (
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-muted-foreground">{row.rawLine}</span>
                  {row.drift.name !== null && (
                    <DriftIndicator
                      axis="name"
                      before={ingredientName}
                      after={row.drift.name}
                    />
                  )}
                  {onReparse && hasDrift(row.drift) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-5 shrink-0 gap-1 px-1 text-xs"
                      disabled={reparsingId !== null}
                      onClick={() => {
                        setReparsingId(row.id);
                        void onReparse(row).finally(() => setReparsingId(null));
                      }}
                      title="Re-parse this line with the current parser and apply"
                    >
                      <ArrowClockwiseIcon className="size-3" />
                      Re-parse
                    </Button>
                  )}
                </span>
              ) : (
                <span
                  className="text-muted-foreground italic"
                  title="No source line captured for this usage"
                >
                  (no source line)
                </span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
