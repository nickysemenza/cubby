import type { WIngredient } from "@cubby/recipebridge";
import type { Amount } from "@cubby/schemas/codec";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { ReadonlyDeep } from "type-fest";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { queryKeys } from "~/lib/query-keys";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import { dedupe } from "~/misc/array-helpers";
import { useTRPC } from "~/trpc/react";
import { CreateIngredientDialog } from "../../combobox/with-search-hook";
import { EntityPillLink } from "../../EntityPill";
import { formatAmounts } from "../../inventory/format-amount";
import { NoneState } from "../../NoneState";
import { useIngredientMatches } from "../use-ingredient-matches";
import type { IngItem } from "./types";

interface ParsedIngredient {
  raw: string;
  parsed: ReadonlyDeep<WIngredient>;
}

interface IngredientMatch {
  id: string;
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
  const parsedIngredients = useMemo<ParsedIngredient[]>(
    () =>
      ingredientLines.map((line) => ({
        raw: line,
        parsed: wasm.parse_ingredient(line),
      })),
    [ingredientLines],
  );

  const uniqueIngredientNames = useMemo(
    () => dedupe(parsedIngredients.map((p) => p.parsed.name)),
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
  parsed: ReadonlyDeep<WIngredient>;
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
  const api = useTRPC();
  const queryClient = useQueryClient();

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
        match: match ? { id: match.id, name: match.name } : null,
        isLoading: !ingredientMatchMap.has(p.parsed.name),
      };
    });
  }, [parsedIngredients, ingredientMatchMap]);

  // State for ingredient creation dialog
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedIngredientName, setSelectedIngredientName] = useState("");

  const createIngredient = useMutation(
    api.ingredient.create.mutationOptions({
      onSuccess: () => {
        // Wrap key in array to match tRPC's nested structure: [["entity", "list"], {...}]
        queryClient.invalidateQueries({
          queryKey: [queryKeys.ingredient.getByName],
        });
        toast.success("Ingredient added.");
        setCreateDialogOpen(false);
      },
    }),
  );

  const handleCreateIngredient = (name: string) => {
    setSelectedIngredientName(name);
    setCreateDialogOpen(true);
  };

  if (ingredientLines.length === 0) {
    return (
      <div className="text-muted-foreground text-sm">
        Enter ingredients to see preview
      </div>
    );
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

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[200px]">Ingredient</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Modifier</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ingredientsWithMatch.map((item, idx) => (
            <IngredientRow
              // biome-ignore lint/suspicious/noArrayIndexKey: stable order from text input
              key={idx}
              item={item}
              onCreateClick={() => handleCreateIngredient(item.parsed.name)}
            />
          ))}
          {isLoadingIngredients && (
            <TableRow>
              <TableCell colSpan={3} className="text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Spinner />
                  Matching ingredients...
                </div>
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
  onCreateClick,
}: {
  item: ParsedIngredientWithMatch;
  onCreateClick: () => void;
}) {
  const isMatched = item.match !== null;
  const isLoading = item.isLoading;

  return (
    <TableRow
      className={cn(
        isLoading && "text-muted-foreground",
        isMatched && "bg-green-50/50",
        !isMatched && !isLoading && "bg-amber-50/50",
      )}
    >
      <TableCell>
        <div className="flex items-center gap-2">
          {isLoading ? (
            <>
              <Spinner className="text-muted-foreground" />
              <span>{item.parsed.name}</span>
            </>
          ) : isMatched && item.match ? (
            <EntityPillLink
              entity="ingredient"
              data={{ id: item.match.id, name: item.match.name }}
            />
          ) : (
            <>
              <AlertCircle className="h-4 w-4 text-amber-600" />
              <span className="text-amber-700">{item.parsed.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-amber-600 hover:bg-amber-100 hover:text-amber-700"
                onClick={onCreateClick}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {item.parsed.amounts.length > 0 ? (
          formatAmounts(item.parsed.amounts)
        ) : (
          <NoneState />
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {item.parsed.modifier || <NoneState />}
      </TableCell>
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
    const missing = dedupe(
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
    const createdIngredients = new Map<string, { id: string; name: string }>();

    for (const name of missingIngredients) {
      try {
        const result = await createIngredientMutation.mutateAsync({
          name,
          aliases: [],
        });
        createdIngredients.set(name, { id: result.id, name: result.name });
      } catch (error) {
        console.error(`Failed to create ingredient: ${name}`, error);
      }
    }

    // Invalidate queries to refresh matches
    // Wrap key in array to match tRPC's nested structure: [["entity", "list"], {...}]
    await queryClient.invalidateQueries({
      queryKey: [queryKeys.ingredient.getByName],
    });

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

        return {
          type: "ingredient" as const,
          ingredient: {
            id: match.id,
            name: match.name,
          },
          recipe: null,
          amounts: p.parsed.amounts.map((a) => ({
            value: a.value,
            unit: a.unit,
          })) as Amount[],
        };
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
    // Parse every line up front, dropping blanks and unparseable (empty-name) lines.
    const parsedGroups = groups.map((lines) =>
      lines
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => wasm.parse_ingredient(line))
        .filter((parsed) => parsed.name.length > 0),
    );

    // Resolve each unique name once: look up, then create if missing.
    const uniqueNames = dedupe(parsedGroups.flat().map((p) => p.name));
    setProgress({ done: 0, total: uniqueNames.length });
    const resolved = new Map<string, { id: string; name: string }>();
    for (const name of uniqueNames) {
      const existing = await queryClient.fetchQuery(
        api.ingredient.getByName.queryOptions({ nameFilter: name }),
      );
      const match = existing
        ? { id: existing.id, name: existing.name }
        : await createIngredientMutation
            .mutateAsync({ name, aliases: [] })
            .then((created) => ({ id: created.id, name: created.name }));
      resolved.set(name, match);
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    return parsedGroups.map((parsed) =>
      parsed.map((p) => {
        const match = resolved.get(p.name);
        if (!match) {
          throw new Error(`No match found for ingredient: ${p.name}`);
        }
        return {
          type: "ingredient" as const,
          ingredient: { id: match.id, name: match.name },
          recipe: null,
          amounts: p.amounts.map((a) => ({
            value: a.value,
            unit: a.unit,
          })) as Amount[],
        };
      }),
    );
  };

  return {
    resolveGroups,
    isResolving: createIngredientMutation.isPending,
    progress,
  };
}
