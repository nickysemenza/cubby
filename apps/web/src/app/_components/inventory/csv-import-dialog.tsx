"use client";

import { useState, useCallback, useRef } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import { Textarea } from "~/components/ui/textarea";
import { Label } from "~/components/ui/label";
import {
  Upload,
  FileSpreadsheet,
  Loader2,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { useTRPC } from "~/trpc/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import Papa from "papaparse";
import {
  type InventoryCSVRow,
  type CSVImportResult,
} from "~/schemas/inventory";
import { UNSPECIFIED_MANUFACTURER } from "~/lib/constants";
import { queryKeys } from "~/lib/query-keys";

interface CSVImportDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CSVImportDialog({
  isOpen,
  onOpenChange,
}: CSVImportDialogProps) {
  const [pastedData, setPastedData] = useState("");
  const [parsedRows, setParsedRows] = useState<InventoryCSVRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<CSVImportResult | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const api = useTRPC();
  const queryClient = useQueryClient();

  const importMutation = useMutation(
    api.inventoryItem.importCSV.mutationOptions({
      onSuccess: (result) => {
        setImportResult(result);
        queryClient.invalidateQueries({
          queryKey: queryKeys.inventoryItem.list,
        });
        queryClient.invalidateQueries({ queryKey: queryKeys.product.list });
        queryClient.invalidateQueries({ queryKey: queryKeys.location.list });
        toast.success(
          `Import complete: ${result.created} created, ${result.moved} moved, ${result.skipped} skipped`,
        );
      },
      onError: (error) => {
        toast.error(`Import failed: ${error.message}`);
      },
    }),
  );

  const parseCSVData = useCallback((data: string) => {
    setParseError(null);
    setParsedRows([]);
    setImportResult(null);

    if (!data.trim()) {
      return;
    }

    // Use papaparse with auto-detect delimiter (handles CSV and TSV from Google Sheets)
    const result = Papa.parse<Record<string, string>>(data, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header) =>
        header.toLowerCase().trim().replace(/\s+/g, "_"),
    });

    if (result.errors.length > 0) {
      setParseError(
        `Parse error: ${result.errors.map((e) => e.message).join(", ")}`,
      );
      return;
    }

    // Validate and transform rows
    const rows: InventoryCSVRow[] = [];
    const errors: string[] = [];

    result.data.forEach((row, index) => {
      const productName = row.product_name || row.product || row.name;
      const locationPath = row.location_path || row.location;
      const quantity = parseFloat(row.quantity || row.qty || "1");
      const unit = row.unit || "each";
      const manufacturer = row.manufacturer || UNSPECIFIED_MANUFACTURER;
      const upc = row.upc || row.barcode || undefined;

      // Parse optional expected_qty (integer)
      const expectedQtyRaw = row.expected_qty || row.expectedqty;
      const expected_qty = expectedQtyRaw
        ? parseInt(expectedQtyRaw, 10)
        : undefined;

      // Parse optional price (decimal)
      const priceRaw = row.price;
      const price = priceRaw ? parseFloat(priceRaw) : undefined;

      // Parse optional unit_mappings (string)
      const unit_mappings = row.unit_mappings || row.unitmappings || null;

      // Parse optional ingredient_name (string)
      const ingredient_name = row.ingredient_name || row.ingredient || null;

      if (!productName) {
        errors.push(`Row ${index + 1}: Missing product name`);
        return;
      }
      if (!locationPath) {
        errors.push(`Row ${index + 1}: Missing location path`);
        return;
      }
      if (isNaN(quantity) || quantity <= 0) {
        errors.push(`Row ${index + 1}: Invalid quantity`);
        return;
      }
      if (
        expected_qty !== undefined &&
        (isNaN(expected_qty) || expected_qty <= 0)
      ) {
        errors.push(
          `Row ${index + 1}: Invalid expected_qty (must be positive integer)`,
        );
        return;
      }
      if (price !== undefined && (isNaN(price) || price <= 0)) {
        errors.push(
          `Row ${index + 1}: Invalid price (must be positive number)`,
        );
        return;
      }

      rows.push({
        product_name: productName,
        manufacturer,
        upc,
        location_path: locationPath,
        quantity,
        unit,
        expected_qty: expected_qty ?? null,
        price: price ?? null,
        unit_mappings,
        ingredient_name,
      });
    });

    if (errors.length > 0) {
      setParseError(
        errors.slice(0, 5).join("\n") +
          (errors.length > 5
            ? `\n... and ${errors.length - 5} more errors`
            : ""),
      );
      return;
    }

    setParsedRows(rows);
  }, []);

  const handlePaste = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const data = e.target.value;
      setPastedData(data);
      parseCSVData(data);
    },
    [parseCSVData],
  );

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const data = event.target?.result as string;
        setPastedData(data);
        parseCSVData(data);
      };
      reader.onerror = () => {
        setParseError("Failed to read file");
      };
      reader.readAsText(file);
    },
    [parseCSVData],
  );

  const handleImport = useCallback(() => {
    if (parsedRows.length === 0) return;
    importMutation.mutate({ rows: parsedRows });
  }, [parsedRows, importMutation]);

  const handleClose = useCallback(() => {
    setPastedData("");
    setParsedRows([]);
    setParseError(null);
    setImportResult(null);
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Import Inventory from CSV
          </DialogTitle>
          <DialogDescription>
            Paste data from Google Sheets or upload a CSV file. Required
            columns: product_name (or product/name), location_path (or
            location). Optional: quantity, unit, manufacturer, upc.
          </DialogDescription>
        </DialogHeader>

        {importResult ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <div className="flex items-center gap-2 text-green-700">
                <CheckCircle2 className="h-5 w-5" />
                <span className="font-medium">Import Complete</span>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-4 text-sm">
                <div>
                  <span className="font-medium text-green-600">
                    {importResult.created}
                  </span>
                  <span className="text-muted-foreground ml-1">created</span>
                </div>
                <div>
                  <span className="font-medium text-blue-600">
                    {importResult.moved}
                  </span>
                  <span className="text-muted-foreground ml-1">moved</span>
                </div>
                <div>
                  <span className="font-medium text-yellow-600">
                    {importResult.skipped}
                  </span>
                  <span className="text-muted-foreground ml-1">skipped</span>
                </div>
                <div>
                  <span className="font-medium text-red-600">
                    {importResult.errors}
                  </span>
                  <span className="text-muted-foreground ml-1">errors</span>
                </div>
              </div>
            </div>

            {importResult.items.length > 0 && (
              <div className="max-h-48 overflow-y-auto rounded border">
                <table className="w-full text-sm">
                  <thead className="bg-muted sticky top-0">
                    <tr>
                      <th className="p-2 text-left">Product</th>
                      <th className="p-2 text-left">Location</th>
                      <th className="p-2 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importResult.items.map((item, i) => (
                      <tr key={i} className="border-t">
                        <td className="p-2">{item.productName}</td>
                        <td className="p-2">{item.locationPath}</td>
                        <td className="p-2">
                          <span
                            className={`rounded px-2 py-0.5 text-xs ${
                              item.action === "created"
                                ? "bg-green-100 text-green-700"
                                : item.action === "moved"
                                  ? "bg-blue-100 text-blue-700"
                                  : item.action === "skipped"
                                    ? "bg-yellow-100 text-yellow-700"
                                    : "bg-red-100 text-red-700"
                            }`}
                          >
                            {item.action}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <DialogFooter>
              <Button onClick={handleClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label htmlFor="csv-paste">Paste CSV/TSV data</Label>
              <Textarea
                id="csv-paste"
                placeholder={`product_name\tlocation_path\tquantity\tunit\nHammer\tGarage > Tools > Shelf 1\t1\teach\nNails (box)\tGarage > Tools > Bin 3\t2\tbox`}
                value={pastedData}
                onChange={handlePaste}
                rows={8}
                className="mt-1 font-mono text-sm"
              />
            </div>

            <div className="flex items-center gap-4">
              <div className="flex-1 border-t" />
              <span className="text-muted-foreground text-sm">or</span>
              <div className="flex-1 border-t" />
            </div>

            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.tsv,.txt"
                onChange={handleFileUpload}
                className="hidden"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                className="w-full"
              >
                <Upload className="mr-2 h-4 w-4" />
                Upload CSV File
              </Button>
            </div>

            {parseError && (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <pre className="whitespace-pre-wrap">{parseError}</pre>
                </div>
              </div>
            )}

            {parsedRows.length > 0 && (
              <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
                <CheckCircle2 className="mr-1 inline h-4 w-4" />
                {parsedRows.length} rows ready to import
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                onClick={handleImport}
                disabled={parsedRows.length === 0 || importMutation.isPending}
              >
                {importMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Importing...
                  </>
                ) : (
                  `Import ${parsedRows.length} Items`
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
