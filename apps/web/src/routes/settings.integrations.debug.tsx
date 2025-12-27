import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import JsonRenderer from "~/app/_components/json-renderer";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/settings/integrations/debug")({
  component: GoogleSheetsDebugPage,
});

function GoogleSheetsDebugPage() {
  const api = useTRPC();

  const { data, isLoading, error } = useQuery(
    api.googleSheets.debugSheetData.queryOptions(),
  );

  if (isLoading) {
    return (
      <div className="container mx-auto py-6">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading sheet data...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto py-6">
        <div className="mb-4">
          <Link to="/settings/integrations">
            <Button variant="outline" size="sm">
              &larr; Back to Integrations
            </Button>
          </Link>
        </div>
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          <p className="font-medium">Error loading sheet data</p>
          <p className="text-sm">{error.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="font-bold text-2xl">Google Sheets Debug</h1>
          <p className="text-muted-foreground text-sm">
            Raw data from connected sheet for troubleshooting
          </p>
        </div>
        <Link to="/settings/integrations">
          <Button variant="outline" size="sm">
            &larr; Back to Integrations
          </Button>
        </Link>
      </div>

      {/* Parse Errors */}
      {data?.parseErrors && data.parseErrors.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 font-semibold text-lg text-red-600">
            Parse Errors ({data.parseErrors.length})
          </h2>
          <div className="rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
            <JsonRenderer input={data.parseErrors} pretty />
          </div>
        </div>
      )}

      {/* Headers */}
      <div className="mb-6">
        <h2 className="mb-2 font-semibold text-lg">
          Headers ({data?.headers.length ?? 0} columns)
        </h2>
        <div className="rounded-md border bg-muted p-4">
          <JsonRenderer input={data?.headers} pretty />
        </div>
      </div>

      {/* Raw Rows */}
      <div className="mb-6">
        <h2 className="mb-2 font-semibold text-lg">
          Raw Rows ({data?.rawRows.length ?? 0} rows)
        </h2>
        <div className="max-h-[500px] overflow-auto rounded-md border bg-muted p-4">
          <JsonRenderer input={data?.rawRows} pretty />
        </div>
      </div>

      {/* Parsed Rows */}
      <div className="mb-6">
        <h2 className="mb-2 font-semibold text-lg">
          Parsed Rows ({data?.parsedRows.length ?? 0} rows)
        </h2>
        <div className="max-h-[500px] overflow-auto rounded-md border bg-muted p-4">
          <JsonRenderer input={data?.parsedRows} pretty />
        </div>
      </div>
    </div>
  );
}
