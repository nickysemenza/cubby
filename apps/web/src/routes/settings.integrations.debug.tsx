import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import JsonRenderer from "~/app/_components/json-renderer";
import { ColoredAlert } from "~/components/common/colored-alert";
import { MutedBox } from "~/components/layout/muted-box";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { authMiddleware } from "~/lib/protected-route";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/settings/integrations/debug")({
  component: GoogleSheetsDebugPage,
  server: {
    middleware: [authMiddleware],
  },
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
          <Spinner />
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
        <ColoredAlert variant="destructive">
          <p className="font-medium">Error loading sheet data</p>
          <p className="text-sm">{error.message}</p>
        </ColoredAlert>
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
          <h2 className="mb-2 font-semibold text-destructive text-lg">
            Parse Errors ({data.parseErrors.length})
          </h2>
          <ColoredAlert variant="destructive">
            <JsonRenderer input={data.parseErrors} pretty />
          </ColoredAlert>
        </div>
      )}

      {/* Headers */}
      <div className="mb-6">
        <h2 className="mb-2 font-semibold text-lg">
          Headers ({data?.headers.length ?? 0} columns)
        </h2>
        <MutedBox className="border">
          <JsonRenderer input={data?.headers} pretty />
        </MutedBox>
      </div>

      {/* Raw Rows */}
      <div className="mb-6">
        <h2 className="mb-2 font-semibold text-lg">
          Raw Rows ({data?.rawRows.length ?? 0} rows)
        </h2>
        <MutedBox className="max-h-[500px] overflow-auto border">
          <JsonRenderer input={data?.rawRows} pretty />
        </MutedBox>
      </div>

      {/* Parsed Rows */}
      <div className="mb-6">
        <h2 className="mb-2 font-semibold text-lg">
          Parsed Rows ({data?.parsedRows.length ?? 0} rows)
        </h2>
        <MutedBox className="max-h-[500px] overflow-auto border">
          <JsonRenderer input={data?.parsedRows} pretty />
        </MutedBox>
      </div>
    </div>
  );
}
