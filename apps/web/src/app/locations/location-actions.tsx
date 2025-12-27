"use client";

import { useQuery } from "@tanstack/react-query";
import { Download, Loader2, Upload } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
  buildCSVContent,
  downloadCSV,
  generateExportFilename,
  toCSVString,
} from "~/lib/csv-utils";
import { useTRPC } from "~/trpc/react";

export function LocationActions() {
  const [isExporting, setIsExporting] = useState(false);
  const api = useTRPC();

  // Export CSV query (only enabled when exporting)
  const exportQuery = useQuery({
    ...api.location.exportCSV.queryOptions(),
    enabled: false,
  });

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      const result = await exportQuery.refetch();
      if (result.data) {
        const headers = [
          "location_name",
          "parent_name",
          "location_type",
          "description",
          "location_image",
        ];
        const rows = result.data.map((row) =>
          headers.map((h) => toCSVString(row[h as keyof typeof row])),
        );

        const csvContent = buildCSVContent(headers, rows);
        downloadCSV(csvContent, generateExportFilename("locations-export"));

        toast.success(`Exported ${result.data.length} locations`);
      }
    } catch (err) {
      console.error("Export failed:", err);
      toast.error("Failed to export locations");
    } finally {
      setIsExporting(false);
    }
  }, [exportQuery]);

  return (
    <>
      <Link href="/locations/import">
        <Button variant="outline">
          <Upload className="mr-1 h-4 w-4" />
          Import CSV
        </Button>
      </Link>
      <Button variant="outline" onClick={handleExport} disabled={isExporting}>
        {isExporting ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <Download className="mr-1 h-4 w-4" />
        )}
        Export CSV
      </Button>
    </>
  );
}
