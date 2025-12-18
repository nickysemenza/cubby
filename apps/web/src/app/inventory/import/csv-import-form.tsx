"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Label } from "~/components/ui/label";
import {
  Upload,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Plus,
  ArrowRightLeft,
  RefreshCw,
  Package,
  MapPin,
  Trash2,
} from "lucide-react";
import { useTRPC } from "~/trpc/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import Papa from "papaparse";
import {
  type InventoryCSVRow,
  type CSVImportResult,
  type CSVImportResultItem,
} from "~/schemas/inventory";
import { UNSPECIFIED_MANUFACTURER } from "~/lib/constants";
import { queryKeys } from "~/lib/query-keys";
import useDebounce from "~/hooks/useDebounce";
import { entities } from "~/entities/entities";

// Helper to get action styles
const getActionStyles = (action: CSVImportResultItem["action"]) => {
  switch (action) {
    case "created":
      return {
        bg: "bg-green-100 text-green-700",
        icon: <Plus className="h-3 w-3" />,
        label: "Create",
      };
    case "moved":
      return {
        bg: "bg-yellow-100 text-yellow-700",
        icon: <ArrowRightLeft className="h-3 w-3" />,
        label: "Move",
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
    case "product_only":
      return {
        bg: "bg-purple-100 text-purple-700",
        icon: <Package className="h-3 w-3" />,
        label: "Product",
      };
    case "removed":
      return {
        bg: "bg-orange-100 text-orange-700",
        icon: <Trash2 className="h-3 w-3" />,
        label: "Remove",
      };
  }
};

// Component to render product changes preview
const ProductChangesPreview = ({ item }: { item: CSVImportResultItem }) => {
  const changes: string[] = [];

  if (item.productWillBeCreated) {
    changes.push("New product");
  }
  if (item.locationWillBeCreated) {
    changes.push("New location");
  }
  if (item.productChanges?.priceWillBeSet) {
    changes.push(`Price: $${item.productChanges.priceWillBeSet}`);
  }
  if (item.productChanges?.expectedQuantityWillBeSet) {
    changes.push(
      `Expected qty: ${item.productChanges.expectedQuantityWillBeSet}`,
    );
  }
  // Unit mappings now shown in dedicated column, not here
  if (item.productChanges?.ingredientWillBeLinked) {
    changes.push(`Link: ${item.productChanges.ingredientWillBeLinked}`);
  }
  if (item.productChanges?.modelWillBeSet) {
    changes.push(`Model: ${item.productChanges.modelWillBeSet}`);
  }
  if (item.productChanges?.ndbNumberWillBeSet) {
    changes.push(`NDB: ${item.productChanges.ndbNumberWillBeSet}`);
  }
  if (
    item.productChanges?.aliasesWillBeAdded &&
    item.productChanges.aliasesWillBeAdded.length > 0
  ) {
    changes.push(
      `Aliases: ${item.productChanges.aliasesWillBeAdded.join(", ")}`,
    );
  }
  if (item.movedFrom && item.movedFrom.length > 0) {
    changes.push(`From: ${item.movedFrom.join(", ")}`);
  }

  if (changes.length === 0) return null;

  return (
    <div className="text-muted-foreground mt-1 flex flex-wrap gap-1 text-xs">
      {changes.map((change, i) => (
        <span
          key={i}
          className="bg-muted inline-flex items-center gap-1 rounded px-1.5 py-0.5"
        >
          {change.startsWith("New product") && <Package className="h-3 w-3" />}
          {change.startsWith("New location") && <MapPin className="h-3 w-3" />}
          {change}
        </span>
      ))}
    </div>
  );
};

export default function CSVImportForm() {
  const router = useRouter();
  const [pastedData, setPastedData] = useState("");
  const [parsedRows, setParsedRows] = useState<InventoryCSVRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<CSVImportResult | null>(
    null,
  );
  const [importResult, setImportResult] = useState<CSVImportResult | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const api = useTRPC();
  const queryClient = useQueryClient();

  // Debounce parsed rows to avoid too many preview requests while typing
  const debouncedRows = useDebounce(parsedRows, 300);

  // Auto-fetch preview when parsed rows change
  const previewMutation = useMutation(
    api.inventoryItem.previewCSVImport.mutationOptions({
      onSuccess: (result) => {
        setPreviewResult(result);
      },
      onError: () => {
        // Silently fail preview - user will see import errors if they try
        setPreviewResult(null);
      },
    }),
  );

  // Fetch preview automatically when debounced rows change
  useEffect(() => {
    if (debouncedRows.length > 0 && !importResult) {
      previewMutation.mutate({ rows: debouncedRows });
    } else if (debouncedRows.length === 0) {
      setPreviewResult(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedRows, importResult]);

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
          `Import complete: ${result.created} created, ${result.moved} moved, ${result.updated} updated`,
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

    // Default column order when no header is provided
    // Also used to detect if first row is a header
    const defaultColumns = [
      "product_name",
      "manufacturer",
      "upc",
      "model",
      "ndb_number",
      "price",
      "unit_mappings",
      "aliases",
      "ingredient",
      "ingredient_name",
      "expected_qty",
      "location_path",
      "quantity",
      "unit",
    ];

    // Column aliases we also recognize as headers
    const columnAliases: Record<string, string[]> = {
      product_name: ["product", "name"],
      upc: ["barcode"],
      ndb_number: ["ndbnumber"],
      unit_mappings: ["unitmappings"],
      expected_qty: ["expectedqty"],
      location_path: ["location"],
      quantity: ["qty"],
    };

    // Build set of all known header names
    const knownHeaders = new Set([
      ...defaultColumns,
      ...Object.values(columnAliases).flat(),
    ]);

    // Check if first row looks like a header
    const firstLineEnd = data.indexOf("\n");
    const firstLine = (
      firstLineEnd > 0 ? data.substring(0, firstLineEnd) : data
    ).trim();
    const firstRowValues = firstLine
      .split(/[,\t]/)
      .map((v) => v.toLowerCase().trim().replace(/\s+/g, "_"));
    const hasHeader = firstRowValues.some((v) => knownHeaders.has(v));

    let result: Papa.ParseResult<Record<string, string>>;

    if (hasHeader) {
      // Parse with headers
      result = Papa.parse<Record<string, string>>(data, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) =>
          header.toLowerCase().trim().replace(/\s+/g, "_"),
      });
    } else {
      // Parse without headers, map columns by position
      const rawResult = Papa.parse<string[]>(data, {
        header: false,
        skipEmptyLines: true,
      });

      // Convert array rows to objects using default column order
      const dataWithHeaders: Record<string, string>[] = rawResult.data.map(
        (row) => {
          const obj: Record<string, string> = {};
          row.forEach((value, index) => {
            if (index < defaultColumns.length) {
              obj[defaultColumns[index]] = value;
            }
          });
          return obj;
        },
      );

      result = {
        data: dataWithHeaders,
        errors: rawResult.errors,
        meta: rawResult.meta as Papa.ParseMeta,
      };
    }

    if (result.errors.length > 0) {
      const errorMessages = result.errors.map((e) => {
        // PapaParse errors include row index (0-based, after header if present)
        const rowOffset = hasHeader ? 2 : 1; // +2 for 1-based + header, +1 for 1-based only
        const rowNum = e.row !== undefined ? e.row + rowOffset : undefined;
        const rowInfo = rowNum ? `Row ${rowNum}: ` : "";
        return `${rowInfo}${e.message}`;
      });
      // Dedupe and limit errors shown
      const uniqueErrors = [...new Set(errorMessages)];
      const displayErrors = uniqueErrors.slice(0, 5);
      const remaining = uniqueErrors.length - displayErrors.length;
      setParseError(
        `Parse error:\n${displayErrors.join("\n")}${remaining > 0 ? `\n... and ${remaining} more errors` : ""}`,
      );
      return;
    }

    // Validate and transform rows
    const rows: InventoryCSVRow[] = [];
    const errors: string[] = [];

    result.data.forEach((row, index) => {
      const productName = row.product_name || row.product || row.name;
      const locationPath = row.location_path || row.location || undefined; // Now optional
      const quantity = parseFloat(row.quantity || row.qty || "1");
      const unit = row.unit || "each";
      const manufacturer = row.manufacturer || UNSPECIFIED_MANUFACTURER;
      const upc = row.upc || row.barcode || undefined;
      const model = row.model || undefined;

      // Parse optional ndb_number (integer)
      const ndbNumberRaw = row.ndb_number || row.ndbnumber;
      const ndb_number = ndbNumberRaw ? parseInt(ndbNumberRaw, 10) : undefined;

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

      // Parse optional ingredient_name (string) - explicit ingredient name
      const ingredient_name = row.ingredient_name || null;

      // Parse optional ingredient flag (boolean) - use product name as ingredient
      const ingredientRaw = row.ingredient;
      const ingredient =
        ingredientRaw === "true" ||
        ingredientRaw === "TRUE" ||
        ingredientRaw === "1"
          ? true
          : undefined;

      // Parse optional aliases (semicolon-separated string)
      const aliases = row.aliases || null;

      if (!productName) {
        errors.push(`Row ${index + 1}: Missing product name`);
        return;
      }
      // location_path is now optional - empty means product-only row
      if (locationPath && (isNaN(quantity) || quantity <= 0)) {
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
      if (ndb_number !== undefined && isNaN(ndb_number)) {
        errors.push(`Row ${index + 1}: Invalid ndb_number (must be a number)`);
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
        model,
        ndb_number,
        location_path: locationPath,
        quantity,
        unit,
        expected_qty: expected_qty ?? null,
        price: price ?? null,
        unit_mappings,
        ingredient_name,
        ingredient,
        aliases,
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

  const handleDone = useCallback(() => {
    router.push(`/${entities["inventory-item"].basePath}`);
  }, [router]);

  const handleReset = useCallback(() => {
    setPastedData("");
    setParsedRows([]);
    setParseError(null);
    setPreviewResult(null);
    setImportResult(null);
  }, []);

  const isPreviewLoading = previewMutation.isPending;

  // Import Result View
  if (importResult) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-green-200 bg-green-50 p-4">
          <div className="flex items-center gap-2 text-green-700">
            <CheckCircle2 className="h-5 w-5" />
            <span className="font-medium">Import Complete</span>
          </div>
          <div className="mt-2 grid grid-cols-6 gap-4 text-sm">
            <div>
              <span className="font-medium text-green-600">
                {importResult.created}
              </span>
              <span className="text-muted-foreground ml-1">created</span>
            </div>
            <div>
              <span className="font-medium text-yellow-600">
                {importResult.moved}
              </span>
              <span className="text-muted-foreground ml-1">moved</span>
            </div>
            <div>
              <span className="font-medium text-blue-600">
                {importResult.updated}
              </span>
              <span className="text-muted-foreground ml-1">updated</span>
            </div>
            <div>
              <span className="font-medium text-purple-600">
                {importResult.productOnly}
              </span>
              <span className="text-muted-foreground ml-1">product only</span>
            </div>
            <div>
              <span className="font-medium text-gray-600">
                {importResult.skipped}
              </span>
              <span className="text-muted-foreground ml-1">skipped</span>
            </div>
            <div>
              <span className="font-medium text-red-600 dark:text-red-400">
                {importResult.errors}
              </span>
              <span className="text-muted-foreground ml-1">errors</span>
            </div>
          </div>
        </div>

        {importResult.items.length > 0 && (
          <div className="max-h-96 overflow-y-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted sticky top-0">
                <tr>
                  <th className="w-20 p-2 text-left">Status</th>
                  <th className="p-2 text-left">Product</th>
                  <th className="p-2 text-left">Location</th>
                </tr>
              </thead>
              <tbody>
                {importResult.items.map((item, i) => {
                  const styles = getActionStyles(item.action);
                  return (
                    <tr key={i} className="border-t">
                      <td className="p-2">
                        <span
                          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${styles.bg}`}
                        >
                          {styles.icon}
                          {styles.label}
                        </span>
                      </td>
                      <td className="p-2">
                        {item.productId ? (
                          <Link
                            href={`/${entities.product.basePath}/${item.productId}`}
                            className="text-primary hover:underline"
                          >
                            {item.productName}
                          </Link>
                        ) : (
                          item.productName
                        )}
                      </td>
                      <td className="p-2">
                        {item.locationPath ? (
                          <div>{item.locationPath}</div>
                        ) : (
                          <span className="text-muted-foreground italic">
                            No location
                          </span>
                        )}
                        {item.message && (
                          <div className="text-muted-foreground text-xs">
                            {item.message}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={handleReset}>
            Import More
          </Button>
          <Button onClick={handleDone}>Done</Button>
        </div>
      </div>
    );
  }

  // Input + Preview View
  return (
    <div className="space-y-4">
      {/* CSV Input */}
      <div>
        <Label htmlFor="csv-paste">Paste CSV/TSV data</Label>
        <Textarea
          id="csv-paste"
          placeholder={`Hammer,Milwaukee,,HMR-1,,15.99,,,,,,Garage > Tools > Shelf 1,1,each\nNails (box),,,,,4.99,,,,,,Garage > Tools > Bin 3,2,box\n\nOr with headers:\nproduct_name,manufacturer,upc,model,ndb_number,price,unit_mappings,aliases,ingredient,ingredient_name,expected_qty,location_path,quantity,unit`}
          value={pastedData}
          onChange={handlePaste}
          rows={6}
          className="mt-1 font-mono text-sm"
        />
      </div>

      {/* File upload */}
      <div className="flex items-center gap-2">
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
          size="sm"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="mr-2 h-4 w-4" />
          Upload File
        </Button>
        {parsedRows.length > 0 && (
          <span className="text-muted-foreground text-sm">
            {parsedRows.length} rows parsed
            {isPreviewLoading && (
              <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />
            )}
          </span>
        )}
      </div>

      {/* Parse Error */}
      {parseError && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <pre className="whitespace-pre-wrap">{parseError}</pre>
          </div>
        </div>
      )}

      {/* Preview Results - shown automatically */}
      {previewResult && previewResult.items.length > 0 && (
        <div className="space-y-2">
          {/* Summary counts */}
          <div className="grid grid-cols-6 gap-2 text-sm">
            <div className="rounded border bg-green-50 p-2 text-center">
              <div className="text-lg font-bold text-green-600">
                {previewResult.created}
              </div>
              <div className="text-muted-foreground text-xs">Create</div>
            </div>
            <div className="rounded border bg-yellow-50 p-2 text-center">
              <div className="text-lg font-bold text-yellow-600">
                {previewResult.moved}
              </div>
              <div className="text-muted-foreground text-xs">Move</div>
            </div>
            <div className="rounded border bg-blue-50 p-2 text-center">
              <div className="text-lg font-bold text-blue-600">
                {previewResult.updated}
              </div>
              <div className="text-muted-foreground text-xs">Update</div>
            </div>
            <div className="rounded border bg-purple-50 p-2 text-center">
              <div className="text-lg font-bold text-purple-600">
                {previewResult.productOnly}
              </div>
              <div className="text-muted-foreground text-xs">Product</div>
            </div>
            <div className="rounded border bg-gray-50 p-2 text-center">
              <div className="text-lg font-bold text-gray-600">
                {previewResult.skipped}
              </div>
              <div className="text-muted-foreground text-xs">Skip</div>
            </div>
            <div className="rounded border bg-red-50 p-2 text-center dark:bg-red-950">
              <div className="text-lg font-bold text-red-600 dark:text-red-400">
                {previewResult.errors}
              </div>
              <div className="text-muted-foreground text-xs">Error</div>
            </div>
          </div>

          {/* Preview table */}
          <div className="max-h-96 overflow-y-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted sticky top-0">
                <tr>
                  <th className="w-20 p-2 text-left">Action</th>
                  <th className="p-2 text-left">Product</th>
                  <th className="p-2 text-left">Location</th>
                  <th className="p-2 text-left">Unit Mappings</th>
                </tr>
              </thead>
              <tbody>
                {previewResult.items.map((item, i) => {
                  const styles = getActionStyles(item.action);
                  const mappings = item.productChanges?.unitMappingsDetail;
                  return (
                    <tr key={i} className="border-t">
                      <td className="p-2">
                        <span
                          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${styles.bg}`}
                        >
                          {styles.icon}
                          {styles.label}
                        </span>
                      </td>
                      <td className="p-2">
                        <div>
                          {item.productId ? (
                            <Link
                              href={`/${entities.product.basePath}/${item.productId}`}
                              className="text-primary hover:underline"
                            >
                              {item.productName}
                            </Link>
                          ) : (
                            item.productName
                          )}
                        </div>
                        <ProductChangesPreview item={item} />
                      </td>
                      <td className="p-2">
                        {item.locationPath ? (
                          <div>{item.locationPath}</div>
                        ) : (
                          <span className="text-muted-foreground italic">
                            No location
                          </span>
                        )}
                        {item.message && (
                          <div className="text-muted-foreground text-xs">
                            {item.message}
                          </div>
                        )}
                      </td>
                      <td className="p-2">
                        {mappings && mappings.length > 0 ? (
                          <div className="text-muted-foreground max-w-48 truncate text-xs">
                            {mappings
                              .map((m) => `${m.from}=${m.to}`)
                              .join(", ")}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-xs">
                            —
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={handleDone}>
          Cancel
        </Button>
        <Button
          onClick={handleImport}
          disabled={
            parsedRows.length === 0 ||
            importMutation.isPending ||
            isPreviewLoading
          }
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
      </div>
    </div>
  );
}
