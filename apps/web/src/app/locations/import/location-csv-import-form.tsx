"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Upload,
} from "lucide-react";
import Link from "next/link";
import Papa from "papaparse";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import useDebounce from "~/hooks/useDebounce";
import { getErrorMessage } from "~/lib/error-utils";
import { queryKeys } from "~/lib/query-keys";
import type {
  LocationCSVImportResult,
  LocationCSVImportResultItem,
  LocationCSVRow,
} from "~/schemas/location";
import { useTRPC } from "~/trpc/react";

// Helper to get action styles
const getActionStyles = (action: LocationCSVImportResultItem["action"]) => {
  switch (action) {
    case "created":
      return {
        bg: "bg-green-100 text-green-700",
        icon: <Plus className="h-3 w-3" />,
        label: "Create",
      };
    case "updated":
      return {
        bg: "bg-blue-100 text-blue-700",
        icon: <RefreshCw className="h-3 w-3" />,
        label: "Update",
      };
    case "skipped":
      return {
        bg: "bg-gray-100 text-gray-700",
        icon: null,
        label: "Skip",
      };
    case "error":
      return {
        bg: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
        icon: <AlertCircle className="h-3 w-3" />,
        label: "Error",
      };
    case "removed":
      return {
        bg: "bg-orange-100 text-orange-700",
        icon: <AlertCircle className="h-3 w-3" />,
        label: "Remove",
      };
  }
};

// Component to render location changes preview
const LocationChangesPreview = ({
  item,
}: {
  item: LocationCSVImportResultItem;
}) => {
  const changes: string[] = [];

  if (item.locationWillBeCreated) {
    changes.push("New location");
  }
  if (item.imageWillBeImported) {
    changes.push("Import image");
  }
  if (item.imageImportSkipped) {
    changes.push("Image exists");
  }

  if (changes.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-1 text-muted-foreground text-xs">
      {changes.map((change) => (
        <span
          key={change}
          className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5"
        >
          {change.includes("image") && <ImageIcon className="h-3 w-3" />}
          {change}
        </span>
      ))}
    </div>
  );
};

export default function LocationCSVImportForm() {
  const csvDataId = useId();
  const [pastedData, setPastedData] = useState("");
  const [parsedRows, setParsedRows] = useState<LocationCSVRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] =
    useState<LocationCSVImportResult | null>(null);
  const [importResult, setImportResult] =
    useState<LocationCSVImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const api = useTRPC();
  const queryClient = useQueryClient();

  // Debounce parsed rows to avoid too many preview requests while typing
  const debouncedRows = useDebounce(parsedRows, 300);

  // Preview mutation with onSuccess handler
  const previewMutation = useMutation(
    api.location.previewCSVImport.mutationOptions({
      onSuccess: (result) => {
        setPreviewResult(result);
      },
      onError: () => {
        // Silently fail preview - user will see import errors if they try
        setPreviewResult(null);
      },
    }),
  );

  // Import mutation
  const importMutation = useMutation(api.location.importCSV.mutationOptions());

  // Parse CSV data - called directly on input change
  const parseCSVData = useCallback((data: string) => {
    setParseError(null);
    setImportResult(null);

    if (!data.trim()) {
      setParsedRows([]);
      return;
    }

    try {
      const result = Papa.parse<Record<string, string>>(data.trim(), {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => header.trim().toLowerCase(),
      });

      if (result.errors.length > 0) {
        const error = result.errors[0];
        setParseError(`Parse error at row ${error.row}: ${error.message}`);
        setParsedRows([]);
        return;
      }

      // Map to LocationCSVRow format
      const rows: LocationCSVRow[] = result.data.map((row) => ({
        location_name: row.location_name?.trim() || "",
        parent_name: row.parent_name?.trim() || null,
        location_type:
          row.location_type?.trim() as LocationCSVRow["location_type"],
        description: row.description?.trim() || null,
        location_image: row.location_image?.trim() || undefined,
      }));

      // Filter out empty rows
      const validRows = rows.filter((row) => row.location_name);
      setParsedRows(validRows);
    } catch (error) {
      setParseError(`Failed to parse: ${getErrorMessage(error)}`);
      setParsedRows([]);
    }
  }, []);

  // Auto-preview when debounced rows change
  useEffect(() => {
    if (debouncedRows.length > 0 && !importResult) {
      previewMutation.mutate({ rows: debouncedRows });
    } else if (debouncedRows.length === 0) {
      setPreviewResult(null);
    }
  }, [debouncedRows, importResult, previewMutation.mutate]);

  // Handle file upload
  const handleFileUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        setPastedData(content);
        parseCSVData(content);
      };
      reader.readAsText(file);
    },
    [parseCSVData],
  );

  // Handle import
  const handleImport = useCallback(() => {
    if (parsedRows.length === 0) return;

    importMutation.mutate(
      { rows: parsedRows },
      {
        onSuccess: (result) => {
          setImportResult(result);
          setPreviewResult(null);

          // Invalidate location queries
          void queryClient.invalidateQueries({
            queryKey: queryKeys.location.list,
          });

          toast.success(
            `Imported ${result.created} locations, ${result.skipped} skipped`,
          );
        },
        onError: (error) => {
          toast.error(`Import failed: ${error.message}`);
        },
      },
    );
  }, [parsedRows, importMutation, queryClient]);

  // Result to display (import result takes priority over preview)
  const displayResult = importResult ?? previewResult;

  const hasActionableItems = previewResult?.items.some(
    (item) => item.action === "created" || item.action === "updated",
  );

  return (
    <div className="space-y-6">
      {/* Input section */}
      <div className="space-y-4">
        <div>
          <Label htmlFor={csvDataId}>Paste CSV Data</Label>
          <Textarea
            id={csvDataId}
            placeholder={`location_name,parent_name,location_type,description,location_image
Kitchen,,room,,
Pantry,Kitchen,shelf,,
Fridge,Kitchen,cabinet,,`}
            className="font-mono text-sm"
            rows={8}
            value={pastedData}
            onChange={(e) => {
              setPastedData(e.target.value);
              parseCSVData(e.target.value);
            }}
          />
        </div>

        <div className="flex items-center gap-4">
          <span className="text-muted-foreground text-sm">or</span>
          <input
            type="file"
            accept=".csv,.tsv,.txt"
            className="hidden"
            ref={fileInputRef}
            onChange={handleFileUpload}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="mr-1 h-4 w-4" />
            Upload File
          </Button>
        </div>
      </div>

      {/* Parse error */}
      {parseError && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-red-700">
          <AlertCircle className="h-4 w-4" />
          {parseError}
        </div>
      )}

      {/* Preview/Import result */}
      {displayResult && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <h3 className="font-semibold">
                {importResult ? "Import Result" : "Preview"}
              </h3>
              <div className="flex gap-3 text-muted-foreground text-sm">
                <span className="text-green-600">
                  {displayResult.created} create
                </span>
                <span className="text-blue-600">
                  {displayResult.updated} update
                </span>
                <span className="text-gray-600">
                  {displayResult.skipped} skip
                </span>
                {displayResult.errors > 0 && (
                  <span className="text-red-600">
                    {displayResult.errors} error
                  </span>
                )}
              </div>
            </div>

            {!importResult && hasActionableItems && (
              <Button
                onClick={handleImport}
                disabled={importMutation.isPending}
              >
                {importMutation.isPending ? (
                  <>
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="mr-1 h-4 w-4" />
                    Import {displayResult.created + displayResult.updated}{" "}
                    Locations
                  </>
                )}
              </Button>
            )}

            {importResult && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setPastedData("");
                    setParsedRows([]);
                    setImportResult(null);
                    setPreviewResult(null);
                  }}
                >
                  Import More
                </Button>
                <Link href="/locations">
                  <Button>View Locations</Button>
                </Link>
              </div>
            )}
          </div>

          {/* Result table */}
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">Action</th>
                  <th className="px-3 py-2 text-left font-medium">
                    Location Name
                  </th>
                  <th className="px-3 py-2 text-left font-medium">Parent</th>
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                  <th className="px-3 py-2 text-left font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {displayResult.items.map((item) => {
                  const style = getActionStyles(item.action);
                  const row = parsedRows[item.rowIndex];

                  return (
                    <tr
                      key={`${item.locationName}-${item.rowIndex}`}
                      className="border-b last:border-b-0 hover:bg-muted/30"
                    >
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium text-xs ${style.bg}`}
                        >
                          {style.icon}
                          {style.label}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div>{item.locationName}</div>
                        <LocationChangesPreview item={item} />
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {row?.parent_name || "-"}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {row?.location_type || "-"}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {item.message || "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Loading state */}
      {previewMutation.isPending && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Previewing changes...
        </div>
      )}

      {/* Empty state */}
      {parsedRows.length === 0 && !parseError && pastedData.trim() === "" && (
        <div className="rounded-md border border-dashed p-8 text-center text-muted-foreground">
          <p>Paste CSV data above to preview the import.</p>
          <p className="mt-1 text-sm">
            Required column: <code>location_name</code>
          </p>
          <p className="mt-1 text-sm">
            Optional columns: <code>parent_name</code>,{" "}
            <code>location_type</code>, <code>description</code>,{" "}
            <code>location_image</code>
          </p>
        </div>
      )}
    </div>
  );
}
