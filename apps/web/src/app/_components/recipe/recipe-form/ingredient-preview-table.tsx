import { useMutation, useQueryClient } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { AlertCircle, AlertTriangle, Eye, EyeOff, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
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
import { useTRPC } from "~/integrations/trpc/react";
import { invalidateTRPCQueries, queryKeys } from "~/lib/query-keys";
import { cn } from "~/lib/utils";
import { CreateIngredientDialog } from "../../combobox/create-entity-dialogs";
import { EntityInlineLink } from "../../EntityInlineLink";
import { formatAmounts } from "../../inventory/format-amount";
import { DecompositionView } from "../decomposition-view";
import { useIngredientMatches } from "../use-ingredient-matches";
import {
  type ParsedIngredientLine,
  parsedIngredientNames,
  parsedIngredientToFormItem,
  parseIngredientLines,
  resolveParsedIngredientGroups,
} from "./ingredient-line-utils";
import type { IngItem } from "./types";

interface IngredientMatch {
  id: string;
  shortcode: string;
  name: string;
  aliases: string[];
}

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
  raw: string;
  parsed: ParsedIngredientLine["parsed"];
  match: {
    id: string;
    shortcode: string;
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
  const api = useTRPC();

  const {
    parsedIngredients,
    ingredientMatchMap,
    isLoading: isLoadingIngredients,
  } = useParsedIngredientMatches(ingredientLines);

  // Combine parsed ingredients with match data
  const ingredientsWithMatch: ParsedIngredientWithMatch[] = useMemo(() => {
    return parsedIngredients.map((p) => {
      const match = ingredientMatchMap.get(p.parsed.name) ?? null;
      return {
        ...p,
        match: match
          ? { id: match.id, shortcode: match.shortcode, name: match.name }
          : null,
        isLoading: !ingredientMatchMap.has(p.parsed.name),
      };
    });
  }, [parsedIngredients, ingredientMatchMap]);

  // State for ingredient creation dialog
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedIngredientName, setSelectedIngredientName] = useState("");
  // Whether the optional "Raw" carve column is shown (off by default).
  const [showRaw, setShowRaw] = useState(false);

  const createIngredient = useActionMutation({
    mutationFn: api.ingredient.create.mutationOptions,
    success: "Ingredient added.",
    invalidateKeys: [queryKeys.ingredient.getByName],
    onSuccess: () => setCreateDialogOpen(false),
  });

  const handleCreateIngredient = (name: string) => {
    setSelectedIngredientName(name);
    setCreateDialogOpen(true);
  };

  if (ingredientLines.length === 0) {
    return <Description as="div">Enter ingredients to see preview</Description>;
  }

  return (
    <>
      <CreateIngredientDialog
        isOpen={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCancel={() => setCreateDialogOpen(false)}
        onCreate={(data) => createIngredient.mutate(data)}
        isPending={createIngredient.isPending}
        error={createIngredient.error?.message}
        initialName={selectedIngredientName}
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
            <TableHead className={cn(showRaw && "w-[30%]")}>
              Ingredient
            </TableHead>
            <TableHead className={cn(showRaw && "w-[20%]")}>Amount</TableHead>
            <TableHead className={cn(showRaw && "w-[16%]")}>Modifier</TableHead>
            {showRaw && <TableHead>Raw</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {ingredientsWithMatch.map((item, idx) => (
            <IngredientRow
              // biome-ignore lint/suspicious/noArrayIndexKey: stable order from text input
              key={idx}
              item={item}
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
  showRaw,
  onCreateClick,
}: {
  item: ParsedIngredientWithMatch;
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
        <Row align="center" gap="sm">
          {isLoading ? (
            <>
              <Spinner className="text-muted-foreground" />
              <span>{item.parsed.name}</span>
            </>
          ) : isMatched && item.match ? (
            <EntityInlineLink
              entity="ingredient"
              data={{
                id: item.match.id,
                shortcode: item.match.shortcode,
                name: item.match.name,
              }}
            />
          ) : (
            <>
              <AlertCircle className="size-4 text-warning" />
              <span className="text-warning">{item.parsed.name}</span>
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
                <span className="inline-flex cursor-help items-center gap-1 text-warning" />
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
        <TableCell className="whitespace-normal break-words text-xs leading-loose">
          <DecompositionView rawLine={item.raw} className="text-foreground" />
        </TableCell>
      )}
    </TableRow>
  );
}

// Export helper to get structured ingredients for form
export function useIngredientImport(ingredientLines: string[]) {
  const api = useTRPC();
  const queryClient = useQueryClient();

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

  // Create ingredient mutation
  const createIngredientMutation = useMutation(
    api.ingredient.create.mutationOptions(),
  );

  // Create all missing ingredients and return structured form data
  const importAll = async (): Promise<IngItem[]> => {
    // Create missing ingredients first
    const createdIngredients = new Map<
      string,
      { id: string; name: string; aliases: string[] }
    >();

    for (const name of missingIngredients) {
      try {
        const result = await createIngredientMutation.mutateAsync({
          name,
          aliases: [],
        });
        createdIngredients.set(name, {
          id: result.id,
          name: result.name,
          aliases: result.aliases ?? [],
        });
      } catch (error) {
        console.error(`Failed to create ingredient: ${name}`, error);
      }
    }

    // Invalidate queries to refresh matches.
    invalidateTRPCQueries(queryClient, [queryKeys.ingredient.getByName]);

    // Build structured ingredients
    const structuredIngredients: IngItem[] = parsedIngredients
      .filter((p) => p.parsed.name.length > 0)
      .map((p) => {
        const match =
          ingredientMatchMap.get(p.parsed.name) ??
          createdIngredients.get(p.parsed.name);

        if (!match) {
          // This shouldn't happen if creation succeeded
          throw new Error(`No match found for ingredient: ${p.parsed.name}`);
        }

        return parsedIngredientToFormItem(p, match);
      });

    return structuredIngredients;
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
    isImporting: createIngredientMutation.isPending,
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
  const api = useTRPC();
  const queryClient = useQueryClient();
  const createIngredientMutation = useMutation(
    api.ingredient.create.mutationOptions(),
  );
  // Progress across the sequential resolve loop, for user-visible feedback.
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

    return resolveParsedIngredientGroups(parsedGroups, async (name) => {
      const existing = await queryClient.fetchQuery(
        api.ingredient.getByName.queryOptions({ nameFilter: name }),
      );
      const match = existing
        ? {
            id: existing.id,
            name: existing.name,
            aliases: existing.aliases ?? [],
          }
        : await createIngredientMutation
            .mutateAsync({ name, aliases: [] })
            .then((created) => ({
              id: created.id,
              name: created.name,
              aliases: created.aliases ?? [],
            }));
      setProgress((p) => ({ ...p, done: p.done + 1 }));
      return match;
    });
  };

  return {
    resolveGroups,
    isResolving: createIngredientMutation.isPending,
    progress,
  };
}
