/**
 * Google Sheets Integration Router
 *
 * Provides two-way sync between inventory and Google Sheets:
 * - Push: Export inventory data to a connected Google Sheet
 * - Pull: Import inventory data from the Google Sheet (with preview)
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  protectedProcedure,
  requireActorContext,
} from "~/server/api/trpc";
import {
  getGoogleSheetsClient,
  GoogleSheetsClient,
} from "~/server/clients/google-sheets";
import { exportInventoryToCSV } from "~/server/repo/inventory/csv-export";
import { importInventoryFromCSV } from "~/server/repo/inventory/csv-import";
import {
  inventoryCSVRow,
  csvImportResult,
  type InventoryCSVRow,
  type CSVImportResult,
  type CSVImportResultItem,
  type FieldChange,
} from "~/schemas/inventory";
import type { InventoryCSVExportRow } from "~/server/repo/inventory/types";
import { organization } from "~/server/db/auth.schema";
import { eq } from "drizzle-orm";
import { getDb } from "~/server/repo/database-helpers";
import { normalizeLocationPath } from "~/lib/location-path";
import { toCSVString } from "~/lib/csv-utils";
import {
  createResultCounters,
  buildImportResult,
  pushResultItem,
} from "~/server/repo/inventory/csv-result-helpers";

// Schema for organization metadata with Google Sheets config
const googleSheetsMetadata = z.object({
  googleSheetId: z.string().nullable().optional(),
  googleSheetLastSync: z.string().nullable().optional(),
});

type GoogleSheetsMetadata = z.infer<typeof googleSheetsMetadata>;

// Parse organization metadata from JSON string
function parseOrgMetadata(metadataStr: string | null): GoogleSheetsMetadata {
  if (!metadataStr) return {};
  try {
    const parsed = JSON.parse(metadataStr);
    return googleSheetsMetadata.parse(parsed);
  } catch {
    return {};
  }
}

// Merge new metadata with existing, preserving other fields
function mergeOrgMetadata(
  existing: string | null,
  updates: Partial<GoogleSheetsMetadata>,
): string {
  const current = existing ? JSON.parse(existing) : {};
  return JSON.stringify({ ...current, ...updates });
}

// CSV column headers for Google Sheets
const CSV_HEADERS = [
  "product_name",
  "manufacturer",
  "upc",
  "model",
  "ndb_number",
  "location_path",
  "quantity",
  "unit",
  "expected_qty",
  "price",
  "unit_mappings",
  "ingredient_name",
  "aliases",
];

// Create a unique key for inventory comparison (product + manufacturer + location)
function makeInventoryKey(
  productName: string,
  manufacturer: string,
  locationPath: string,
): string {
  return `${productName.toLowerCase()}|${manufacturer.toLowerCase()}|${normalizeLocationPath(locationPath)}`;
}

// Compare two row values and return structured field changes
function getRowDifferences(
  appRow: InventoryCSVExportRow,
  sheetRow: InventoryCSVRow,
): FieldChange[] {
  const changes: FieldChange[] = [];

  // Compare location_path (exact match - includes bracket notation)
  if (appRow.location_path !== (sheetRow.location_path ?? "")) {
    changes.push({
      field: "location",
      from: sheetRow.location_path ?? null,
      to: appRow.location_path,
    });
  }

  // For quantity/unit, treat null (product-only rows) as equivalent to defaults (1/each)
  // since the sheet schema applies these defaults when parsing empty cells
  const appQty = appRow.quantity ?? 1;
  const appUnit = appRow.unit ?? "each";
  if (appQty !== sheetRow.quantity) {
    changes.push({
      field: "qty",
      from: sheetRow.quantity,
      to: appRow.quantity,
    });
  }
  if (appUnit !== sheetRow.unit) {
    changes.push({ field: "unit", from: sheetRow.unit, to: appRow.unit });
  }
  if ((appRow.upc ?? "") !== (sheetRow.upc ?? "")) {
    changes.push({
      field: "upc",
      from: sheetRow.upc ?? null,
      to: appRow.upc ?? null,
    });
  }
  if ((appRow.model ?? "") !== (sheetRow.model ?? "")) {
    changes.push({
      field: "model",
      from: sheetRow.model ?? null,
      to: appRow.model ?? null,
    });
  }
  if ((appRow.ndb_number ?? null) !== (sheetRow.ndb_number ?? null)) {
    changes.push({
      field: "ndb",
      from: sheetRow.ndb_number ?? null,
      to: appRow.ndb_number ?? null,
    });
  }
  if ((appRow.expected_qty ?? null) !== (sheetRow.expected_qty ?? null)) {
    changes.push({
      field: "expected",
      from: sheetRow.expected_qty ?? null,
      to: appRow.expected_qty ?? null,
    });
  }
  if ((appRow.price ?? null) !== (sheetRow.price ?? null)) {
    changes.push({
      field: "price",
      from: sheetRow.price ?? null,
      to: appRow.price ?? null,
    });
  }
  if ((appRow.unit_mappings ?? "") !== (sheetRow.unit_mappings ?? "")) {
    changes.push({
      field: "unit_mappings",
      from: sheetRow.unit_mappings ?? null,
      to: appRow.unit_mappings ?? null,
    });
  }
  if ((appRow.ingredient_name ?? "") !== (sheetRow.ingredient_name ?? "")) {
    changes.push({
      field: "ingredient",
      from: sheetRow.ingredient_name ?? null,
      to: appRow.ingredient_name ?? null,
    });
  }
  if ((appRow.aliases ?? "") !== (sheetRow.aliases ?? "")) {
    changes.push({
      field: "aliases",
      from: sheetRow.aliases ?? null,
      to: appRow.aliases ?? null,
    });
  }

  return changes;
}

// Compare app inventory rows with sheet rows to generate a diff preview
function compareInventoryForPush(
  appRows: InventoryCSVExportRow[],
  sheetRows: InventoryCSVRow[],
): CSVImportResult {
  const items: CSVImportResultItem[] = [];
  const counters = createResultCounters();

  // Build a map of sheet rows by key
  const sheetMap = new Map<string, InventoryCSVRow>();
  for (const row of sheetRows) {
    const key = makeInventoryKey(
      row.product_name,
      row.manufacturer ?? "(unspecified)",
      row.location_path ?? "",
    );
    sheetMap.set(key, row);
  }

  // Track which sheet keys we've seen
  const seenSheetKeys = new Set<string>();

  // Compare app rows against sheet
  for (let i = 0; i < appRows.length; i++) {
    const appRow = appRows[i];
    const key = makeInventoryKey(
      appRow.product_name,
      appRow.manufacturer,
      appRow.location_path,
    );
    seenSheetKeys.add(key);

    const sheetRow = sheetMap.get(key);

    if (!sheetRow) {
      // New row - doesn't exist in sheet
      pushResultItem(items, counters, "created", {
        rowIndex: i,
        productName: appRow.product_name,
        locationPath: appRow.location_path,
        locationId: appRow.location_id ?? undefined,
        message: "Will be added to sheet",
      });
    } else {
      // Row exists - check if different
      const fieldChanges = getRowDifferences(appRow, sheetRow);

      if (fieldChanges.length > 0) {
        pushResultItem(items, counters, "updated", {
          rowIndex: i,
          productName: appRow.product_name,
          locationPath: appRow.location_path,
          locationId: appRow.location_id ?? undefined,
          fieldChanges,
        });
      } else {
        pushResultItem(items, counters, "skipped", {
          rowIndex: i,
          productName: appRow.product_name,
          locationPath: appRow.location_path,
          locationId: appRow.location_id ?? undefined,
        });
      }
    }
  }

  // Find rows in sheet that aren't in app (will be removed)
  for (const [key, sheetRow] of sheetMap) {
    if (!seenSheetKeys.has(key)) {
      pushResultItem(items, counters, "removed", {
        rowIndex: -1, // Not in app
        productName: sheetRow.product_name,
        locationPath: sheetRow.location_path ?? undefined,
        message: "Will be removed from sheet",
      });
    }
  }

  return buildImportResult(counters, items);
}

// Parse currency string to number (handles $, commas, etc.)
function parseCurrency(value: string | undefined): number | undefined {
  if (!value || value.trim() === "") return undefined;
  // Strip currency symbols, commas, and whitespace
  const cleaned = value.replace(/[$,\s]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? undefined : num;
}

// Parse error for a sheet row
type SheetParseError = {
  rowIndex: number;
  productName: string;
  error: string;
};

// Result of parsing sheet rows
type ParseSheetResult = {
  rows: InventoryCSVRow[];
  errors: SheetParseError[];
};

// Helper context type for procedures that need sheet access
type SheetContext = {
  db: Parameters<typeof getDb>[0];
  organizationId: string;
};

// Get configured client and validated sheet ID, or throw appropriate error
async function getClientAndSheetId(ctx: SheetContext): Promise<{
  client: ReturnType<typeof getGoogleSheetsClient>;
  sheetId: string;
  orgMetadata: string | null;
}> {
  const client = getGoogleSheetsClient();

  if (!client.isConfigured()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Google Sheets integration is not configured",
    });
  }

  const org = await getDb(ctx.db).query.organization.findFirst({
    where: eq(organization.id, ctx.organizationId),
    columns: { metadata: true },
  });

  const metadata = parseOrgMetadata(org?.metadata ?? null);
  const sheetId = metadata.googleSheetId;

  if (!sheetId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "No Google Sheet connected. Please connect a sheet first.",
    });
  }

  return { client, sheetId, orgMetadata: org?.metadata ?? null };
}

// Convert parse errors to CSVImportResultItem array
function parseErrorsToItems(errors: SheetParseError[]): CSVImportResultItem[] {
  return errors.map((err) => ({
    rowIndex: err.rowIndex,
    action: "error" as const,
    productName: err.productName,
    message: err.error,
  }));
}

// Empty import result constant
const EMPTY_IMPORT_RESULT: CSVImportResult = {
  created: 0,
  moved: 0,
  updated: 0,
  skipped: 0,
  errors: 0,
  productOnly: 0,
  items: [],
};

// Update organization's last sync timestamp
async function updateLastSyncTimestamp(
  ctx: SheetContext,
  existingMetadata: string | null,
): Promise<void> {
  const newMetadata = mergeOrgMetadata(existingMetadata, {
    googleSheetLastSync: new Date().toISOString(),
  });

  await getDb(ctx.db)
    .update(organization)
    .set({ metadata: newMetadata })
    .where(eq(organization.id, ctx.organizationId));
}

// Merge import result with parse errors
function mergeResultWithErrors(
  result: CSVImportResult,
  errorItems: CSVImportResultItem[],
): CSVImportResult {
  return {
    ...result,
    errors: result.errors + errorItems.length,
    items: [...result.items, ...errorItems],
  };
}

// Convert sheet rows (2D array) to InventoryCSVRow[]
function parseSheetRows(rows: string[][]): ParseSheetResult {
  if (rows.length < 2) return { rows: [], errors: [] }; // Need header + at least one data row

  const headers = rows[0].map((h) =>
    h.toLowerCase().trim().replace(/\s+/g, "_"),
  );
  const dataRows = rows.slice(1);

  const parsed: InventoryCSVRow[] = [];
  const errors: SheetParseError[] = [];

  for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
    const row = dataRows[rowIdx];
    // Create object from headers and row values
    const rowObj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      rowObj[headers[i]] = row[i] ?? "";
    }

    // Skip empty rows
    const productName =
      rowObj.product_name || rowObj.product || rowObj.name || "";
    if (!productName) {
      continue;
    }

    const result = inventoryCSVRow.safeParse({
      product_name: productName,
      manufacturer: rowObj.manufacturer || undefined,
      upc: rowObj.upc || rowObj.barcode || undefined,
      model: rowObj.model || undefined,
      ndb_number: rowObj.ndb_number || rowObj.ndbnumber || undefined,
      location_path: rowObj.location_path || rowObj.location || undefined,
      quantity: rowObj.quantity || rowObj.qty || 1,
      unit: rowObj.unit || "each",
      expected_qty: rowObj.expected_qty || rowObj.expectedqty || undefined,
      price: parseCurrency(rowObj.price),
      unit_mappings: rowObj.unit_mappings || rowObj.unitmappings || undefined,
      ingredient_name: rowObj.ingredient_name || undefined,
      ingredient: rowObj.ingredient,
      aliases: rowObj.aliases || undefined,
    });

    if (result.success) {
      parsed.push(result.data);
    } else {
      // Capture the first error message
      const firstIssue = result.error.issues[0];
      const errorMsg = firstIssue
        ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
        : "Invalid row data";
      errors.push({
        rowIndex: rowIdx + 2, // +2 for 1-based index and header row
        productName,
        error: errorMsg,
      });
    }
  }

  return { rows: parsed, errors };
}

// Get connection status
const getConnectionStatus = protectedProcedure
  .output(
    z.object({
      configured: z.boolean(),
      connected: z.boolean(),
      sheetId: z.string().nullable(),
      sheetName: z.string().nullable(),
      lastSync: z.string().nullable(),
      serviceAccountEmail: z.string().nullable(),
    }),
  )
  .query(async ({ ctx }) => {
    const client = getGoogleSheetsClient();
    const configured = client.isConfigured();
    const serviceAccountEmail = client.getServiceAccountEmail() ?? null;

    // Get org metadata
    const org = await getDb(ctx.db).query.organization.findFirst({
      where: eq(organization.id, ctx.organizationId),
      columns: { metadata: true },
    });

    const metadata = parseOrgMetadata(org?.metadata ?? null);
    const sheetId = metadata.googleSheetId ?? null;
    const lastSync = metadata.googleSheetLastSync ?? null;

    // Check if we can access the sheet
    let sheetName: string | null = null;
    let connected = false;

    if (configured && sheetId) {
      sheetName = await client.validateAccess(sheetId);
      connected = sheetName !== null;
    }

    return {
      configured,
      connected,
      sheetId,
      sheetName,
      lastSync,
      serviceAccountEmail,
    };
  });

// Test connection to a sheet URL
const testConnection = protectedProcedure
  .input(
    z.object({
      sheetUrl: z.string().url(),
    }),
  )
  .output(
    z.object({
      success: z.boolean(),
      sheetId: z.string().nullable(),
      sheetName: z.string().nullable(),
      error: z.string().nullable(),
    }),
  )
  .mutation(async ({ input }) => {
    const client = getGoogleSheetsClient();

    if (!client.isConfigured()) {
      return {
        success: false,
        sheetId: null,
        sheetName: null,
        error:
          "Google Sheets integration is not configured. Please set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY environment variables.",
      };
    }

    const sheetId = GoogleSheetsClient.extractSheetId(input.sheetUrl);
    if (!sheetId) {
      return {
        success: false,
        sheetId: null,
        sheetName: null,
        error:
          "Invalid Google Sheets URL. Expected format: https://docs.google.com/spreadsheets/d/{sheetId}/...",
      };
    }

    const sheetName = await client.validateAccess(sheetId);
    if (!sheetName) {
      const email = client.getServiceAccountEmail();
      return {
        success: false,
        sheetId,
        sheetName: null,
        error: `Cannot access the sheet. Make sure you've shared it with ${email} as an Editor.`,
      };
    }

    return {
      success: true,
      sheetId,
      sheetName,
      error: null,
    };
  });

// Save sheet connection to organization
const updateSheetConnection = protectedProcedure
  .input(
    z.object({
      sheetUrl: z.string().url().nullable(),
    }),
  )
  .output(z.object({ success: z.boolean() }))
  .mutation(async ({ ctx, input }) => {
    const sheetId = input.sheetUrl
      ? GoogleSheetsClient.extractSheetId(input.sheetUrl)
      : null;

    // Get current metadata
    const org = await getDb(ctx.db).query.organization.findFirst({
      where: eq(organization.id, ctx.organizationId),
      columns: { metadata: true },
    });

    // Update metadata with new sheet ID
    const newMetadata = mergeOrgMetadata(org?.metadata ?? null, {
      googleSheetId: sheetId,
      googleSheetLastSync: null, // Reset last sync when changing sheet
    });

    await getDb(ctx.db)
      .update(organization)
      .set({ metadata: newMetadata })
      .where(eq(organization.id, ctx.organizationId));

    return { success: true };
  });

// Preview what pushing to sheet would do
const previewPush = protectedProcedure
  .output(csvImportResult)
  .mutation(async ({ ctx }) => {
    const { client, sheetId } = await getClientAndSheetId(ctx);

    // Get app inventory and current sheet data
    const appRows = await exportInventoryToCSV(ctx.db, ctx.organizationId);
    const sheetData = await client.readSheet(sheetId);
    const { rows: sheetRows } = parseSheetRows(sheetData);

    return compareInventoryForPush(appRows, sheetRows);
  });

// Push inventory to Google Sheet
const pushToSheet = protectedProcedure
  .output(
    z.object({
      success: z.boolean(),
      rowCount: z.number(),
    }),
  )
  .mutation(async ({ ctx }) => {
    const { client, sheetId, orgMetadata } = await getClientAndSheetId(ctx);

    // Export inventory to rows
    const exportRows = await exportInventoryToCSV(ctx.db, ctx.organizationId);

    // Convert to string[][] for Google Sheets
    const dataRows = exportRows.map((row) =>
      CSV_HEADERS.map((h) => toCSVString(row[h as keyof typeof row])),
    );

    // Write to sheet (headers + data)
    await client.writeSheet(sheetId, [CSV_HEADERS, ...dataRows]);
    await updateLastSyncTimestamp(ctx, orgMetadata);

    return { success: true, rowCount: exportRows.length };
  });

// Pull from Google Sheet (preview mode)
const pullFromSheet = protectedProcedure
  .output(csvImportResult)
  .mutation(async ({ ctx }) => {
    const { client, sheetId } = await getClientAndSheetId(ctx);
    const actor = requireActorContext(ctx);

    // Read and parse sheet data
    const sheetData = await client.readSheet(sheetId);
    const { rows: parsedRows, errors: parseErrors } = parseSheetRows(sheetData);
    const errorItems = parseErrorsToItems(parseErrors);

    if (parsedRows.length === 0 && errorItems.length === 0) {
      return EMPTY_IMPORT_RESULT;
    }

    // Run import in preview mode
    const result = await importInventoryFromCSV(
      ctx.db,
      actor.organizationId,
      parsedRows,
      {
        dryRun: true,
        actor: { ...actor, source: "sheets_import" },
      },
    );

    return mergeResultWithErrors(result, errorItems);
  });

// Apply pull from Google Sheet
const applyPull = protectedProcedure
  .output(csvImportResult)
  .mutation(async ({ ctx }) => {
    const { client, sheetId, orgMetadata } = await getClientAndSheetId(ctx);
    const actor = requireActorContext(ctx);

    // Read and parse sheet data
    const sheetData = await client.readSheet(sheetId);
    const { rows: parsedRows, errors: parseErrors } = parseSheetRows(sheetData);
    const errorItems = parseErrorsToItems(parseErrors);

    if (parsedRows.length === 0 && errorItems.length === 0) {
      return EMPTY_IMPORT_RESULT;
    }

    // Run actual import
    const result = await importInventoryFromCSV(
      ctx.db,
      actor.organizationId,
      parsedRows,
      {
        dryRun: false,
        actor: { ...actor, source: "sheets_import" },
      },
    );

    await updateLastSyncTimestamp(ctx, orgMetadata);
    return mergeResultWithErrors(result, errorItems);
  });

// Debug endpoint - returns raw sheet data for troubleshooting
const debugSheetData = protectedProcedure
  .output(
    z.object({
      headers: z.array(z.string()),
      rawRows: z.array(z.array(z.string())),
      parsedRows: z.array(inventoryCSVRow),
      parseErrors: z.array(
        z.object({
          rowIndex: z.number(),
          productName: z.string(),
          error: z.string(),
        }),
      ),
    }),
  )
  .query(async ({ ctx }) => {
    const { client, sheetId } = await getClientAndSheetId(ctx);

    // Read raw sheet data
    const rawData = await client.readSheet(sheetId);
    const headers = rawData[0]?.map((h) => h ?? "") ?? [];
    const rawRows = rawData
      .slice(1)
      .map((row) => row.map((cell) => cell ?? ""));

    // Parse rows
    const { rows: parsedRows, errors: parseErrors } = parseSheetRows(rawData);

    return { headers, rawRows, parsedRows, parseErrors };
  });

export const googleSheetsRouter = createTRPCRouter({
  getConnectionStatus,
  testConnection,
  updateSheetConnection,
  previewPush,
  pushToSheet,
  pullFromSheet,
  applyPull,
  debugSheetData,
});
