"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { entities } from "~/entities/entities";
import { Zap, Upload, Download, Loader2 } from "lucide-react";
import { CSVImportDialog } from "~/app/_components/inventory/csv-import-dialog";
import { useTRPC } from "~/trpc/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  buildCSVContent,
  downloadCSV,
  generateExportFilename,
} from "~/lib/csv-utils";

export function InventoryActions() {
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const api = useTRPC();

  // Export CSV query (only enabled when exporting)
  const exportQuery = useQuery({
    ...api.inventoryItem.exportCSV.queryOptions({}),
    enabled: false,
  });

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      const result = await exportQuery.refetch();
      if (result.data) {
        const headers = [
          "product_name",
          "manufacturer",
          "upc",
          "location_path",
          "quantity",
          "unit",
          "expected_qty",
          "price",
          "unit_mappings",
          "ingredient_name",
        ];
        const rows = result.data.map((row) => [
          row.product_name,
          row.manufacturer ?? "",
          row.upc ?? "",
          row.location_path,
          String(row.quantity),
          row.unit,
          row.expected_qty != null ? String(row.expected_qty) : "",
          row.price != null ? String(row.price) : "",
          row.unit_mappings ?? "",
          row.ingredient_name ?? "",
        ]);

        const csvContent = buildCSVContent(headers, rows);
        downloadCSV(csvContent, generateExportFilename("inventory-export"));

        toast.success(`Exported ${result.data.length} inventory items`);
      }
    } catch (err) {
      console.error("Export failed:", err);
      toast.error("Failed to export inventory");
    } finally {
      setIsExporting(false);
    }
  }, [exportQuery]);

  return (
    <>
      <Link href={`/${entities["inventory-item"].basePath}/quick-capture`}>
        <Button variant="default">
          <Zap className="mr-1 h-4 w-4" />
          Quick Capture
        </Button>
      </Link>
      <Button variant="outline" onClick={() => setIsImportOpen(true)}>
        <Upload className="mr-1 h-4 w-4" />
        Import CSV
      </Button>
      <Button variant="outline" onClick={handleExport} disabled={isExporting}>
        {isExporting ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <Download className="mr-1 h-4 w-4" />
        )}
        Export CSV
      </Button>
      <Link href={`/${entities["inventory-item"].basePath}/bulk-edit`}>
        <Button variant="outline">Bulk Edit</Button>
      </Link>
      <Link href={`/${entities["inventory-item"].basePath}/new`}>
        <Button variant="outline">Create New</Button>
      </Link>

      <CSVImportDialog isOpen={isImportOpen} onOpenChange={setIsImportOpen} />
    </>
  );
}
