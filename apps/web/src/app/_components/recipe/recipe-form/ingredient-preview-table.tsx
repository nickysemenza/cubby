import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { uniq } from "es-toolkit";
import { AlertCircle, AlertTriangle, Eye, EyeOff, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { NoneValue } from "~/components/ui/none-value";
import { Spinner } from "~/components/ui/spinner";
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
import { captureRequest } from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";
import { cn } from "~/lib/utils";

import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "../../entity-media/entity-display-images";
import { EntityInlineLink } from "../../EntityInlineLink";
import { formatAmounts } from "../../inventory/format-amount";
import { DecompositionView } from "../decomposition-view";
import {
  type IngredientMatch,
  useIngredientMatches,
} from "../use-ingredient-matches";
import {
  ingredientNameKey,
  useResolveIngredientNames,
} from "../use-resolve-ingredient-names";
import {
  type ParsedIngredientLine,
  parsedIngredientNames,
  parsedIngredientToFormItem,
  parseIngredientLines,
  resolveParsedIngredientGroups,
} from "./ingredient-line-utils";
import type { IngItem } from "./types";

/**
 * Parse ingredient lines via WASM and match each unique parsed name against the
 * ingredient DB. Shared by IngredientPreviewTable (display) and useIngredientImport
 * (form import) so the parse + lookup logic lives in exactly one place.
 *
 * Returns a Map keyed by parsed name: a value of `null` means "looked up, not found",
 * while a missing key means "still loading".
 */
function useParsedIngredientMatches(ingredientLines: string[]) {
  const parsedIngredients = useMemo<ParsedIngredientLine[]>(
    () => parseIngredientLines(ingredientLines, { requireName: true }),
    [ingredientLines],
  );

  const uniqueIngredientNames = useMemo(
    () => parsedIngredientNames(parsedIngredients),
    [parsedIngredients],
  );

  // One batched `matchNames` lookup (shared with the cookbook importer) instead
  // of one `getByName` per name.
  const { matchMap, isLoading } = useIngredientMatches(uniqueIngredientNames);

  // Re-key by the original-case parsed name for this module's consumers. A
  // missing key means "still loading"; `null` means "looked up, not found".
  const ingredientMatchMap = useMemo(() => {
    const map = new Map<string, IngredientMatch | null>();
    if (!isLoading) {
      for (const name of uniqueIngredientNames) {
        map.set(name, matchMap.get(name.toLowerCase()) ?? null);
      }
    }
    return map;
  }, [uniqueIngredientNames, matchMap, isLoading]);

  return { parsedIngredients, ingredientMatchMap, isLoading };
}

interface ParsedIngredientWithMatch {
  rowKey: string;
  raw: string;
  parsed: ParsedIngredientLine["parsed"];
  match: {
    id: string;
    name: string;
  } | null;
  isLoading: boolean;
}

interface IngredientPreviewTableProps {
  ingredientLines: string[];
}

export function IngredientPreviewTable({
  ingredientLines,
}: IngredientPreviewTableProps) {
  const {
    parsedIngredients,
    ingredientMatchMap,
    isLoading: isLoadingIngredients,
  } = useParsedIngredientMatches(ingredientLines);

  // Combine parsed ingredients with match data
  const ingredientsWithMatch: ParsedIngredientWithMatch[] = useMemo(() => {
    const occurrences = new Map<string, number>();
    return parsedIngredients.map((p) => {
      const match = ingredientMatchMap.get(p.parsed.name) ?? null;
      const occurrence = occurrences.get(p.raw) ?? 0;
      occurrences.set(p.raw, occurrence + 1);
      return {
        ...p,
        rowKey: `${p.raw}\u0000${occurrence}`,
        match: match ? { id: match.id, name: match.name } : null,
        isLoading: !ingredientMatchMap.has(p.parsed.name),
      };
    });
  }, [parsedIngredients, ingredientMatchMap]);
  const imageRefs = useMemo(
    () =>
      ingredientsWithMatch.flatMap((item) =>
        item.match
          ? [{ entityType: "ingredient" as const, entityId: item.match.id }]
          : [],
      ),
    [ingredientsWithMatch],
  );
  const displayImages = useEntityDisplayImages(imageRefs);

  // State for ingredient creation dialog
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedIngredientName, setSelectedIngredientName] = useState("");
  // Whether the optional "Raw" carve column is shown (off by default).
  const [showRaw, setShowRaw] = useState(false);

  const handleCreateIngredient = (name: string) => {
    setSelectedIngredientName(name);
    setCreateDialogOpen(true);
  };

  if (ingredientLines.length === 0) {
    return <Description as="div">Enter ingredients to see preview</Description>;
  }

  return (
    <>
      <EntityEditDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        request={captureRequest("ingredient", { name: selectedIngredientName })}
      />

      {/* "Raw" shows the grammar's carve of each source line. Off by default so
          the common view stays a tidy 3-column table; toggle it on to inspect
          how a line parsed (the carve column wraps, the others don't). */}
      <Row justify="end" className="mb-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="gap-1 text-2xs text-muted-foreground"
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
          {showRaw ? "Hide raw" : "Show raw"}
        </Button>
      </Row>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={showRaw ? "w-[30%]" : "w-1/2"}>
              Ingredient
            </TableHead>
            <TableHead className={showRaw ? "w-[20%]" : "w-1/4"}>
              Amount
            </TableHead>
            <TableHead className={showRaw ? "w-[16%]" : "w-1/4"}>
              Modifier
            </TableHead>
            {showRaw && <TableHead className="w-[34%]">Raw</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {ingredientsWithMatch.map((item) => (
            <IngredientRow
              key={item.rowKey}
              item={item}
              displayImage={
                item.match
                  ? (displayImages[
                      entityDisplayImageKey({
                        entityType: "ingredient",
                        entityId: item.match.id,
                      })
                    ] ?? null)
                  : null
              }
              showRaw={showRaw}
              onCreateClick={() => handleCreateIngredient(item.parsed.name)}
            />
          ))}
          {isLoadingIngredients && (
            <TableRow>
              <TableCell
                colSpan={showRaw ? 4 : 3}
                className="text-muted-foreground"
              >
                <Row align="center" gap="sm">
                  <Spinner />
                  Matching ingredients...
                </Row>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </>
  );
}

function IngredientRow({
  item,
  displayImage,
  showRaw,
  onCreateClick,
}: {
  item: ParsedIngredientWithMatch;
  displayImage: ImageUrlSummary | null;
  showRaw: boolean;
  onCreateClick: () => void;
}) {
  const isMatched = item.match !== null;
  const isLoading = item.isLoading;

  return (
    <TableRow
      className={cn(
        isLoading && "text-muted-foreground",
        isMatched && "bg-positive/10",
        !isMatched && !isLoading && "bg-warning/10",
      )}
    >
      <TableCell>
        <Row align="center" gap="sm" className="min-w-0">
          {isLoading ? (
            <>
              <Spinner className="text-muted-foreground" />
              <span className="min-w-0 truncate">{item.parsed.name}</span>
            </>
          ) : isMatched && item.match ? (
            <EntityInlineLink
              displayImage={displayImage}
              entity="ingredient"
              data={{
                id: item.match.id,
                name: item.match.name,
              }}
              truncate
            />
          ) : (
            <>
              <AlertCircle className="size-4 text-warning" />
              <span className="min-w-0 truncate text-warning-ink">
                {item.parsed.name}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-6 p-0 text-warning hover:bg-warning/15 hover:text-warning"
                onClick={onCreateClick}
              >
                <Plus className="size-4" />
              </Button>
            </>
          )}
        </Row>
      </TableCell>
      {/* `unparsed_digit` means the line carried a number the parser couldn't
          turn into an amount (a likely-missed quantity) — surfaced here, where
          the amount would otherwise read as a bare "none", so it can be fixed
          before saving. We key off `unparsed_digit` only; `fell_back` alone is
          noisy (every legit name-only line falls back). */}
      <TableCell className="text-muted-foreground">
        {item.parsed.amounts.length > 0 ? (
          formatAmounts(item.parsed.amounts)
        ) : item.parsed.parse_notes.unparsed_digit ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex cursor-help items-center gap-1 text-warning-ink" />
              }
            >
              <AlertTriangle className="size-3.5" />
              <span className="text-xs">No amount read</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              This line has a number, but the parser couldn't read a quantity
              from it. Check the line and add an amount before saving.
            </TooltipContent>
          </Tooltip>
        ) : (
          <NoneValue />
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {item.parsed.modifier || <NoneValue />}
      </TableCell>
      {/* Raw carve: where each refined field came from in the source line. The
            columns above carry the parser's *structured* reading (e.g. two
            independent amounts from "1 cup (200g)"); the carve can't show that
            split, so it complements the columns rather than replacing them.
            `whitespace-normal` lets the mono line wrap instead of overflowing the
            fixed-layout column; underlines clone across wraps (box-decoration). */}
      {showRaw && (
        <TableCell className="text-xs leading-loose break-words whitespace-normal">
          <DecompositionView rawLine={item.raw} className="text-foreground" />
        </TableCell>
      )}
    </TableRow>
  );
}

// Export helper to get structured ingredients for form
export function useIngredientImport(ingredientLines: string[]) {
  const { parsedIngredients, ingredientMatchMap, isLoading } =
    useParsedIngredientMatches(ingredientLines);

  const { namesForHighlighting, missingIngredients } = useMemo(() => {
    // Names to highlight in instructions: parsed names + matched canonical names + aliases
    const names = new Set<string>();
    parsedIngredients.forEach((p) => {
      if (p.parsed.name.length > 0) {
        names.add(p.parsed.name);
      }
      const match = ingredientMatchMap.get(p.parsed.name);
      if (match) {
        names.add(match.name);
        for (const alias of match.aliases) {
          names.add(alias);
        }
      }
    });

    // Parsed names with no existing match (created on import). A still-loading
    // name has no map entry yet, so it counts as missing until the lookup settles.
    const missing = uniq(
      parsedIngredients
        .filter(
          (p) =>
            !ingredientMatchMap.has(p.parsed.name) ||
            ingredientMatchMap.get(p.parsed.name) === null,
        )
        .filter((p) => p.parsed.name.length > 0)
        .map((p) => p.parsed.name),
    );

    return {
      namesForHighlighting: Array.from(names),
      missingIngredients: missing,
    };
  }, [parsedIngredients, ingredientMatchMap]);

  const { resolveNames, isResolving } = useResolveIngredientNames();

  // Resolve every parsed name (not just the ones the display map reads as
  // missing) and return structured form data. Handing the whole list to the
  // server costs the same one round-trip and keeps the import off the cached
  // match map, which can lag a create this same form just made.
  const importAll = async (): Promise<IngItem[]> => {
    const rows = parsedIngredients.filter((p) => p.parsed.name.length > 0);
    const matches = await resolveNames(parsedIngredientNames(rows));

    return rows.map((p) => {
      const match = matches.get(ingredientNameKey(p.parsed.name));
      if (!match) {
        throw new Error(`No match found for ingredient: ${p.parsed.name}`);
      }
      return parsedIngredientToFormItem(p, match);
    });
  };

  return {
    isLoading,
    missingCount: missingIngredients.length,
    matchedCount: parsedIngredients.filter(
      (p) =>
        p.parsed.name.length > 0 &&
        ingredientMatchMap.get(p.parsed.name) !== null,
    ).length,
    totalCount: parsedIngredients.filter((p) => p.parsed.name.length > 0)
      .length,
    namesForHighlighting,
    importAll,
    isImporting: isResolving,
  };
}

/**
 * Imperatively resolve grouped ingredient lines (e.g. one group per scraped
 * recipe section) into structured form ingredients, creating any missing
 * ingredients in the DB. Unlike useIngredientImport — which reactively tracks a
 * single flat textarea and collapses everything into one section — this
 * preserves section grouping. Each unique name is resolved once across all
 * groups, so a name repeated across sections is only created once.
 */
export function useIngredientResolver() {
  const { resolveNames, isResolving } = useResolveIngredientNames();
  // How many names the in-flight resolve covers, for user-visible feedback.
  const [progress, setProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });

  const resolveGroups = async (groups: string[][]): Promise<IngItem[][]> => {
    const parsedGroups = groups.map((lines) =>
      parseIngredientLines(lines, { requireName: true }),
    );
    const uniqueNames = parsedIngredientNames(parsedGroups.flat());
    setProgress({ done: 0, total: uniqueNames.length });

    const matches = await resolveNames(uniqueNames);
    setProgress({ done: uniqueNames.length, total: uniqueNames.length });

    return resolveParsedIngredientGroups(parsedGroups, async (name) => {
      const match = matches.get(ingredientNameKey(name));
      if (!match) {
        throw new Error(`Failed to resolve ingredient: ${name}`);
      }
      return match;
    });
  };

  return { resolveGroups, isResolving, progress };
}
