import type { WAmount, WIngredient } from "@recipehub/recipebridge";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { Amount } from "~/codec/codec";
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
import { NoneState } from "../../NoneState";
import type { IngItem } from "./types";

// Format a single amount like "2 cups" or "2-3 cups" (for ranges)
function formatAmount(a: WAmount): string {
  if (a.upper_value !== undefined && a.upper_value !== a.value) {
    return `${a.value}-${a.upper_value} ${a.unit}`;
  }
  return `${a.value} ${a.unit}`;
}

// Format all amounts, joined with ", "
function formatAmounts(amounts: WAmount[]): string {
  return amounts.map(formatAmount).join(", ");
}

export interface ParsedIngredientWithMatch {
  raw: string;
  parsed: WIngredient;
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

  // Parse ingredients via WASM
  const parsedIngredients = useMemo(() => {
    return ingredientLines.map((line) => ({
      raw: line,
      parsed: wasm.parse_ingredient(line),
    }));
  }, [ingredientLines]);

  // Extract unique ingredient names for DB lookup
  const ingredientNames = useMemo(
    () => parsedIngredients.map((p) => p.parsed.name),
    [parsedIngredients],
  );
  const uniqueIngredientNames = dedupe(ingredientNames);

  // Query DB for each unique ingredient name
  const ingredientQueries = useQueries({
    queries: uniqueIngredientNames.map((name) => ({
      ...api.ingredient.getByName.queryOptions({ nameFilter: name }),
      staleTime: 30000,
      enabled: name.length > 0,
    })),
  });

  // Build a map of ingredient name -> DB match
  const ingredientMatchMap = useMemo(() => {
    const map = new Map<string, { id: string; name: string } | null>();
    uniqueIngredientNames.forEach((name, index) => {
      const query = ingredientQueries[index];
      if (query && !query.isLoading) {
        map.set(
          name,
          query.data ? { id: query.data.id, name: query.data.name } : null,
        );
      }
    });
    return map;
  }, [uniqueIngredientNames, ingredientQueries]);

  // Check if any queries are still loading
  const isLoadingIngredients = ingredientQueries.some((q) => q.isLoading);

  // Combine parsed ingredients with match data
  const ingredientsWithMatch: ParsedIngredientWithMatch[] = useMemo(() => {
    return parsedIngredients.map((p) => ({
      ...p,
      match: ingredientMatchMap.get(p.parsed.name) ?? null,
      isLoading: !ingredientMatchMap.has(p.parsed.name),
    }));
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
        toast.success("Ingredient created!");
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

  // Parse ingredients via WASM
  const parsedIngredients = useMemo(() => {
    return ingredientLines.map((line) => ({
      raw: line,
      parsed: wasm.parse_ingredient(line),
    }));
  }, [ingredientLines]);

  // Extract unique ingredient names for DB lookup
  const ingredientNames = useMemo(
    () => parsedIngredients.map((p) => p.parsed.name),
    [parsedIngredients],
  );
  const uniqueIngredientNames = dedupe(ingredientNames);

  // Query DB for each unique ingredient name
  const ingredientQueries = useQueries({
    queries: uniqueIngredientNames.map((name) => ({
      ...api.ingredient.getByName.queryOptions({ nameFilter: name }),
      staleTime: 30000,
      enabled: name.length > 0,
    })),
  });

  // Build a map of ingredient name -> DB match (including aliases)
  const ingredientMatchMap = useMemo(() => {
    const map = new Map<
      string,
      { id: string; name: string; aliases: string[] } | null
    >();
    uniqueIngredientNames.forEach((name, index) => {
      const query = ingredientQueries[index];
      if (query && !query.isLoading) {
        map.set(
          name,
          query.data
            ? {
                id: query.data.id,
                name: query.data.name,
                aliases: query.data.aliases,
              }
            : null,
        );
      }
    });
    return map;
  }, [uniqueIngredientNames, ingredientQueries]);

  const isLoading = ingredientQueries.some((q) => q.isLoading);

  // Collect all names for rich text highlighting (parsed + matched + aliases)
  const namesForHighlighting = useMemo(() => {
    const names = new Set<string>();
    parsedIngredients.forEach((p) => {
      // Add parsed name
      if (p.parsed.name.length > 0) {
        names.add(p.parsed.name);
      }
      // Add matched DB name + aliases
      const match = ingredientMatchMap.get(p.parsed.name);
      if (match) {
        names.add(match.name);
        for (const alias of match.aliases) {
          names.add(alias);
        }
      }
    });
    return Array.from(names);
  }, [parsedIngredients, ingredientMatchMap]);

  // Get missing ingredient names
  const missingIngredients = useMemo(() => {
    return dedupe(
      parsedIngredients
        .filter(
          (p) =>
            !ingredientMatchMap.has(p.parsed.name) ||
            ingredientMatchMap.get(p.parsed.name) === null,
        )
        .filter((p) => p.parsed.name.length > 0)
        .map((p) => p.parsed.name),
    );
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
