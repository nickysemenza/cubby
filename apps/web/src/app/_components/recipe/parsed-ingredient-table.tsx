import { AlertCircle, Plus } from "lucide-react";
import { Fragment, useMemo } from "react";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { EntityInlineLink } from "../EntityInlineLink";
import { formatAmounts } from "../inventory/format-amount";
import { CopyCorpusButton } from "./copy-corpus-button";
import { parseIngredientLines } from "./recipe-form/ingredient-line-utils";
import type { IngredientMatchMap } from "./use-ingredient-matches";

/**
 * Compact parsed-ingredient table shared by the cookbook importer and (optionally)
 * the recipe form: each line is parsed with WASM and shown as name / amount /
 * modifier, with matched ingredients rendered as an inline link and unmatched
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
  const rows = useMemo(() => {
    const occurrences = new Map<string, number>();
    return parseIngredientLines(lines).map((row) => {
      const occurrence = occurrences.get(row.raw) ?? 0;
      occurrences.set(row.raw, occurrence + 1);
      return { ...row, rowKey: `${row.raw}\u0000${occurrence}` };
    });
  }, [lines]);
  if (rows.length === 0) return null;
  return (
    <Table className="table-auto">
      <TableBody>
        {rows.map(({ raw, parsed, rowKey }) => {
          const name = parsed.name || raw;
          const match = parsed.name
            ? matchMap.get(parsed.name.toLowerCase())
            : null;
          const isNew = matchReady && !match;
          const tint = cn(match && "bg-positive/10", isNew && "bg-warning/10");
          return (
            <Fragment key={rowKey}>
              {/* Name/amount/modifier row pairs with its raw-line row below; suppress
                  the border here so the divider only falls between items. */}
              <TableRow className={cn("border-b-0", tint)}>
                <TableCell className="whitespace-normal align-top">
                  {match ? (
                    <EntityInlineLink
                      displayImage={undefined}
                      entity="ingredient"
                      data={match}
                    />
                  ) : (
                    <Row as="span" align="center" gap="xs">
                      {isNew && (
                        <AlertCircle className="size-3 shrink-0 text-warning" />
                      )}
                      <span className={isNew ? "text-warning" : ""}>
                        {name}
                      </span>
                      {isNew && onCreate ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="size-5 p-0 text-warning hover:bg-warning/15 hover:text-warning"
                          onClick={() => onCreate(parsed.name)}
                          title="Add to your library"
                        >
                          <Plus className="size-3" />
                        </Button>
                      ) : (
                        isNew && (
                          <span
                            className="text-warning"
                            title="Will be created on import"
                          >
                            · new
                          </span>
                        )
                      )}
                    </Row>
                  )}
                </TableCell>
                <TableCell className="align-top text-muted-foreground">
                  {parsed.amounts.length > 0
                    ? formatAmounts(parsed.amounts)
                    : ""}
                </TableCell>
                <TableCell className="whitespace-normal align-top text-muted-foreground">
                  {parsed.modifier ?? ""}
                </TableCell>
              </TableRow>
              <TableRow className={tint}>
                <TableCell
                  colSpan={2}
                  className="whitespace-normal pt-0 pb-1 text-2xs text-muted-foreground leading-tight"
                >
                  {raw}
                </TableCell>
                <TableCell className="pt-0 pb-1 text-right align-top">
                  <CopyCorpusButton
                    rawLine={raw}
                    name={parsed.name}
                    amounts={parsed.amounts}
                    modifier={parsed.modifier}
                    label={undefined}
                  />
                </TableCell>
              </TableRow>
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}
