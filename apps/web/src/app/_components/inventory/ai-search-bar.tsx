import type { ParsedSearch } from "@cubby/schemas/ai";
import type { Table } from "@tanstack/react-table";
import { Sparkles, X } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { useTRPCClient } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";

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
    <Stack gap="sm">
      <Row align="center" gap="sm">
        <div className="relative flex-1">
          <Sparkles className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
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
            <X className="size-4" />
          </Button>
        )}
        {isLoading && <Spinner />}
      </Row>

      {result && (
        <Description size="xs" className="px-1">
          {result.interpretation}
        </Description>
      )}
    </Stack>
  );
}
