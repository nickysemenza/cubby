import type { ParsedSearch } from "@cubby/schemas/ai";
import type { Table } from "@tanstack/react-table";
import { Sparkles, X } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { useTRPCClient } from "~/trpc/react";

interface AiSearchBarProps<T> {
  table: Table<T>;
}

export function AiSearchBar<T>({ table }: AiSearchBarProps<T>) {
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<ParsedSearch | null>(null);

  const trpcClient = useTRPCClient();

  const applyFilters = useCallback(
    (parsed: ParsedSearch) => {
      if (parsed.productName) {
        table.getColumn("product")?.setFilterValue(parsed.productName);
      }
      if (parsed.locationName) {
        table.getColumn("location")?.setFilterValue(parsed.locationName);
      }
    },
    [table],
  );

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;

    setIsLoading(true);
    try {
      const parsed = await trpcClient.ai.parseSearch.mutate({
        query: query.trim(),
      });
      setResult(parsed);
      applyFilters(parsed);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [query, trpcClient, applyFilters]);

  const handleClear = useCallback(() => {
    setQuery("");
    setResult(null);
    table.getColumn("product")?.setFilterValue(undefined);
    table.getColumn("location")?.setFilterValue(undefined);
  }, [table]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSearch();
      }
    },
    [handleSearch],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Sparkles className="absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder='Ask: "where are the canned tomatoes?"'
            className="pl-9" /* tight: clears absolute icon */
            disabled={isLoading}
          />
        </div>
        {result && (
          <Button type="button" variant="ghost" size="sm" onClick={handleClear}>
            <X className="h-4 w-4" />
          </Button>
        )}
        {isLoading && <Spinner />}
      </div>

      {result && (
        <p className="px-1 text-muted-foreground text-xs">
          {result.interpretation}
        </p>
      )}
    </div>
  );
}
