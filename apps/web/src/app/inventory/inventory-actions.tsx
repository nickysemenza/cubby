import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download, Loader2, Upload, Zap } from "lucide-react";
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

export function InventoryActions() {
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
        const rows = result.data.map((row) =>
          headers.map((h) => toCSVString(row[h as keyof typeof row])),
        );

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
      <Link to="/inventory/quick-capture">
        <Button variant="default">
          <Zap className="mr-1 h-4 w-4" />
          Quick Capture
        </Button>
      </Link>
      <Link to="/inventory/import">
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
      <Link to="/inventory/bulk-edit">
        <Button variant="outline">Bulk Edit</Button>
      </Link>
      <Link to="/inventory/new">
        <Button variant="outline">Create New</Button>
      </Link>
    </>
  );
}
