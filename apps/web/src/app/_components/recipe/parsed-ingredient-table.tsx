import type { WAmount } from "@cubby/recipebridge";
import { AlertCircle, Plus } from "lucide-react";
import { Fragment, useMemo } from "react";
import type { ReadonlyDeep } from "type-fest";

import { Row } from "~/components/layout";
import { badgeVariants } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "~/components/ui/table";
import { cn } from "~/lib/utils";

import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "../entity-media/entity-display-images";
import { EntityInlineLink } from "../EntityInlineLink";
import { formatAmounts } from "../inventory/format-amount";
import { CopyCorpusButton } from "./copy-corpus-button";
import { parseIngredientLines } from "./recipe-form/ingredient-line-utils";
import type { IngredientMatchMap } from "./use-ingredient-matches";

/** A line that names another recipe in the same book, as the crate resolved it. */
export type SubRecipeLink = {
  /** The tree item id the reference resolved to. */
  targetId: string;
  /** The target's display name, for the chip. */
  label: string;
  /** The target will exist after import, so this line becomes a recipe link. */
  linkable: boolean;
  /** Present when the target is listed in this book and can be scrolled to. */
  onJump?: () => void;
};

/**
 * One already-parsed line. Callers that hold a parse they must not contradict
 * — the cookbook importer, whose lines were parsed by the `cookbook` crate and
 * are persisted exactly as parsed — pass these instead of raw strings.
 */
export type ParsedLineRow = {
  raw: string;
  parsed: {
    name: string;
    amounts: readonly ReadonlyDeep<WAmount>[];
    modifier?: string | null;
  };
  link?: SubRecipeLink;
};

/**
 * Compact parsed-ingredient table shared by the cookbook importer and (optionally)
 * the recipe form: each line is shown as name / amount / modifier, with matched
 * ingredients rendered as an inline link and unmatched ones flagged. `matchMap`
 * comes from {@link useIngredientMatches} (one batched lookup); when `onCreate`
 * is given, unmatched rows get a "+" to create the ingredient (recipe-form
 * behavior); otherwise they read "· new" (cookbook import, which find-or-creates
 * on import).
 *
 * Pass `rows` to render a parse the caller already holds, or `lines` to have
 * them parsed here with WASM. The cookbook importer takes the first path
 * deliberately: its parse came from the crate and is the one the import stores,
 * so re-parsing here could show a reading that never gets persisted.
 */
export function ParsedIngredientTable({
  lines,
  rows: providedRows,
  matchMap,
  matchReady,
  onCreate,
}: {
  lines?: string[];
  rows?: readonly ParsedLineRow[];
  matchMap: IngredientMatchMap;
  matchReady: boolean;
  onCreate?: (name: string) => void;
}) {
  const rows = useMemo<(ParsedLineRow & { rowKey: string })[]>(() => {
    const occurrences = new Map<string, number>();
    const source: readonly ParsedLineRow[] =
      providedRows ?? parseIngredientLines(lines ?? []);
    return source.map((row) => {
      const occurrence = occurrences.get(row.raw) ?? 0;
      occurrences.set(row.raw, occurrence + 1);
      return { ...row, rowKey: `${row.raw}\u0000${occurrence}` };
    });
  }, [lines, providedRows]);
  const imageRefs = useMemo(
    () =>
      rows.flatMap((row) => {
        const matched = row.parsed.name
          ? matchMap.get(row.parsed.name.toLowerCase())
          : null;
        return matched
          ? [{ entityType: "ingredient" as const, entityId: matched.id }]
          : [];
      }),
    [matchMap, rows],
  );
  const displayImages = useEntityDisplayImages(imageRefs);
  if (rows.length === 0) return null;
  return (
    <Table className="table-auto">
      <TableBody>
        {rows.map(({ raw, parsed, link, rowKey }) => {
          const name = parsed.name || raw;
          const match = parsed.name
            ? matchMap.get(parsed.name.toLowerCase())
            : null;
          // A line that resolves to another recipe in the book is never a new
          // ingredient — it becomes a sub-recipe link — so the "will be created"
          // warning would be describing something that does not happen.
          const isNew = matchReady && !match && !link?.linkable;
          const tint = cn(match && "bg-positive/10", isNew && "bg-warning/10");
          return (
            <Fragment key={rowKey}>
              {/* Name/amount/modifier row pairs with its raw-line row below; suppress
                  the border here so the divider only falls between items. */}
              <TableRow className={cn("border-b-0", tint)}>
                <TableCell className="align-top whitespace-normal">
                  <Row as="span" wrap align="center" gap="xs">
                    {match ? (
                      <EntityInlineLink
                        displayImage={
                          displayImages[
                            entityDisplayImageKey({
                              entityType: "ingredient",
                              entityId: match.id,
                            })
                          ] ?? null
                        }
                        entity="ingredient"
                        data={match}
                      />
                    ) : (
                      <Row as="span" align="center" gap="xs">
                        {isNew && (
                          <AlertCircle className="size-3 shrink-0 text-warning" />
                        )}
                        <span className={isNew ? "text-warning-ink" : ""}>
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
                              className="text-warning-ink"
                              title="Will be created on import"
                            >
                              · new
                            </span>
                          )
                        )}
                      </Row>
                    )}
                    {link && <SubRecipeChip link={link} />}
                  </Row>
                </TableCell>
                <TableCell className="align-top text-muted-foreground">
                  {parsed.amounts.length > 0
                    ? formatAmounts(parsed.amounts)
                    : ""}
                </TableCell>
                <TableCell className="align-top whitespace-normal text-muted-foreground">
                  {parsed.modifier ?? ""}
                </TableCell>
              </TableRow>
              <TableRow className={tint}>
                <TableCell
                  colSpan={2}
                  className="pt-0 pb-1 text-2xs leading-tight whitespace-normal text-muted-foreground"
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

/**
 * "→ Pie Dough" on an ingredient line the crate resolved to another recipe.
 * Filled means the target will exist after import and the line becomes a recipe
 * link; hollow means it will not, and the line stays a plain ingredient. That
 * distinction is the whole point of showing the chip before importing.
 */
function SubRecipeChip({ link }: { link: SubRecipeLink }) {
  const className = badgeVariants({
    variant: link.linkable ? "secondary" : "outline",
  });
  const label = (
    <>
      → {link.label}
      {!link.linkable && " (not selected)"}
    </>
  );
  if (!link.onJump) {
    return (
      <span
        className={className}
        title={
          link.linkable
            ? "Will link to this recipe"
            : "Target recipe is not in this import — stays an ingredient"
        }
      >
        {label}
      </span>
    );
  }
  const onJump = link.onJump;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onJump();
      }}
      title={
        link.linkable
          ? "Will link to this recipe — click to jump"
          : "In this book — click to jump"
      }
      className={cn(className, "cursor-pointer hover:underline")}
    >
      {label}
    </button>
  );
}
