/**
 * Google Sheets Integration Router
 *
 * Provides two-way sync between inventory and Google Sheets:
 * - Push: Export inventory data to a connected Google Sheet
 * - Pull: Import inventory data from the Google Sheet (with preview)
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import {
  getGoogleSheetsClient,
  GoogleSheetsClient,
  SHEET_NAMES,
} from "~/server/clients/google-sheets";
import { exportInventoryToCSV } from "~/server/repo/inventory/csv-export";
import { importInventoryFromCSV } from "~/server/repo/inventory/csv-import";
import {
  inventoryCSVRow,
  csvImportResult,
  type InventoryCSVRow,
  type CSVImportResult,
  type CSVImportResultItem,
} from "~/schemas/inventory";
import {
  locationCSVRow,
  locationCSVImportResult,
  type LocationCSVRow,
  type LocationCSVImportResult,
  type LocationCSVImportResultItem,
} from "~/schemas/location";
import { organization } from "~/server/db/auth.schema";
import { eq } from "drizzle-orm";
import { getDb } from "~/server/repo/database-helpers";
import { toCSVString } from "~/lib/csv-utils";
import {
  compareInventoryForPush,
  findRemovedInventoryForPull,
  detectRenamesForPull,
  type RemovedInventoryItem,
} from "~/server/repo/inventory/csv-comparison";
import { exportLocationsToCSV } from "~/server/repo/location/csv-export";
import { importLocationsFromCSV } from "~/server/repo/location/csv-import";
import { compareLocationsForPush } from "~/server/repo/location/csv-comparison";
import type { OrganizationId } from "~/schemas/identifiers";
import { deleteInventoryEntry } from "~/server/repo/inventory";
import { deleteProduct } from "~/server/repo/product";

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

// CSV column headers for Inventory sheet
const INVENTORY_CSV_HEADERS = [
  "product_name",
  "manufacturer",
  "upc",
  "model",
  "ndb_number",
  "location_name",
  "quantity",
  "unit",
  "expected_qty",
  "price",
  "unit_mappings",
  "ingredient_name",
  "aliases",
  "product_image",
];

// CSV column headers for Locations sheet
const LOCATION_CSV_HEADERS = [
  "location_name",
  "parent_name",
  "location_type",
  "description",
  "location_image",
];

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
  organizationId: OrganizationId;
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

// Prepare data for pull operations (shared between preview and apply)
type PullData = {
  parsedRows: InventoryCSVRow[];
  appRows: Awaited<ReturnType<typeof exportInventoryToCSV>>; // App rows for rename detection
  errorItems: CSVImportResultItem[];
  removedItems: RemovedInventoryItem[];
  orgMetadata: string | null;
  isEmpty: boolean;
};

// Combined pull data for both sheets
type CombinedPullData = {
  inventory: PullData;
  locations: {
    parsedRows: LocationCSVRow[];
    errorItems: LocationCSVImportResultItem[];
  };
  orgMetadata: string | null;
};

async function prepareCombinedPullData(
  ctx: SheetContext,
): Promise<CombinedPullData> {
  const { client, sheetId, orgMetadata } = await getClientAndSheetId(ctx);

  // Read inventory sheet
  const inventorySheetData = await client.readSheet(
    sheetId,
    SHEET_NAMES.INVENTORY,
  );
  const { rows: inventoryParsedRows, errors: inventoryParseErrors } =
    parseSheetRows(inventorySheetData);
  const inventoryErrorItems = parseErrorsToItems(inventoryParseErrors);

  // Get current app inventory to detect deletions and renames
  const inventoryAppRows = await exportInventoryToCSV(
    ctx.db,
    ctx.organizationId,
  );
  const removedItems = findRemovedInventoryForPull(
    inventoryAppRows,
    inventoryParsedRows,
  );

  // Try to read locations sheet
  let locationParsedRows: LocationCSVRow[] = [];
  let locationErrorItems: LocationCSVImportResultItem[] = [];
  try {
    const sheets = await client.listSheets(sheetId);
    if (sheets.includes(SHEET_NAMES.LOCATIONS)) {
      const locationSheetData = await client.readSheet(
        sheetId,
        SHEET_NAMES.LOCATIONS,
      );
      const { rows, errors } = parseLocationSheetRows(locationSheetData);
      locationParsedRows = rows;
      locationErrorItems = locationParseErrorsToItems(errors);
    }
  } catch {
    // Locations sheet doesn't exist, skip location import
  }

  return {
    inventory: {
      parsedRows: inventoryParsedRows,
      appRows: inventoryAppRows, // Include app rows for rename detection
      errorItems: inventoryErrorItems,
      removedItems,
      orgMetadata,
      isEmpty:
        inventoryParsedRows.length === 0 &&
        inventoryErrorItems.length === 0 &&
        removedItems.length === 0,
    },
    locations: {
      parsedRows: locationParsedRows,
      errorItems: locationErrorItems,
    },
    orgMetadata,
  };
}

// Build final pull result by merging import result with errors and removed items
function buildPullResult(
  result: CSVImportResult,
  errorItems: CSVImportResultItem[],
  removedItems: RemovedInventoryItem[],
): CSVImportResult {
  const mergedResult = mergeResultWithErrors(result, errorItems);
  return {
    ...mergedResult,
    removed: (mergedResult.removed ?? 0) + removedItems.length,
    items: [...mergedResult.items, ...removedItems],
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
      location_name: rowObj.location_name || rowObj.location || undefined,
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

// Parse location sheet rows (2D array) to LocationCSVRow[]
type LocationParseError = {
  rowIndex: number;
  locationName: string;
  error: string;
};

type ParseLocationSheetResult = {
  rows: LocationCSVRow[];
  errors: LocationParseError[];
};

function parseLocationSheetRows(rows: string[][]): ParseLocationSheetResult {
  if (rows.length < 2) return { rows: [], errors: [] };

  const headers = rows[0].map((h) =>
    h.toLowerCase().trim().replace(/\s+/g, "_"),
  );
  const dataRows = rows.slice(1);

  const parsed: LocationCSVRow[] = [];
  const errors: LocationParseError[] = [];

  for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
    const row = dataRows[rowIdx];
    const rowObj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      rowObj[headers[i]] = row[i] ?? "";
    }

    const locationName = rowObj.location_name || rowObj.name || "";
    if (!locationName) {
      continue; // Skip empty rows
    }

    const result = locationCSVRow.safeParse({
      location_name: locationName,
      parent_name: rowObj.parent_name || rowObj.parent || null,
      location_type: rowObj.location_type || rowObj.type || undefined,
      description: rowObj.description || undefined,
      location_image: rowObj.location_image || rowObj.image || undefined,
    });

    if (result.success) {
      parsed.push(result.data);
    } else {
      const firstIssue = result.error.issues[0];
      const errorMsg = firstIssue
        ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
        : "Invalid row data";
      errors.push({
        rowIndex: rowIdx + 2,
        locationName,
        error: errorMsg,
      });
    }
  }

  return { rows: parsed, errors };
}

// Convert location parse errors to LocationCSVImportResultItem array
function locationParseErrorsToItems(
  errors: LocationParseError[],
): LocationCSVImportResultItem[] {
  return errors.map((err) => ({
    rowIndex: err.rowIndex,
    action: "error" as const,
    locationName: err.locationName,
    message: err.error,
  }));
}

// Combined sync result for both inventory and locations
const combinedSyncResult = z.object({
  inventory: csvImportResult,
  locations: locationCSVImportResult,
});

// Empty location import result
const EMPTY_LOCATION_RESULT: LocationCSVImportResult = {
  created: 0,
  updated: 0,
  skipped: 0,
  errors: 0,
  items: [],
};

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

// Preview what pushing to sheet would do (combined for both sheets)
const previewPush = protectedProcedure
  .output(combinedSyncResult)
  .mutation(async ({ ctx }) => {
    const { client, sheetId } = await getClientAndSheetId(ctx);

    // Get app data for both inventory and locations
    const inventoryAppRows = await exportInventoryToCSV(
      ctx.db,
      ctx.organizationId,
    );
    const locationAppRows = await exportLocationsToCSV(
      ctx.db,
      ctx.organizationId,
    );

    // Get list of existing sheets
    const sheets = await client.listSheets(sheetId);

    // Determine which sheet to read for inventory (handle legacy "Sheet1")
    const inventorySheetName = sheets.includes(SHEET_NAMES.INVENTORY)
      ? SHEET_NAMES.INVENTORY
      : sheets.includes("Sheet1")
        ? "Sheet1"
        : null;

    // Read inventory sheet data (may not exist yet)
    let inventorySheetRows: InventoryCSVRow[] = [];
    if (inventorySheetName) {
      const inventorySheetData = await client.readSheet(
        sheetId,
        inventorySheetName,
      );
      const parsed = parseSheetRows(inventorySheetData);
      inventorySheetRows = parsed.rows;
    }

    // Read locations sheet data (may not exist yet)
    let locationSheetRows: LocationCSVRow[] = [];
    if (sheets.includes(SHEET_NAMES.LOCATIONS)) {
      const locationSheetData = await client.readSheet(
        sheetId,
        SHEET_NAMES.LOCATIONS,
      );
      const parsed = parseLocationSheetRows(locationSheetData);
      locationSheetRows = parsed.rows;
    }

    return {
      inventory: compareInventoryForPush(inventoryAppRows, inventorySheetRows),
      locations: compareLocationsForPush(locationAppRows, locationSheetRows),
    };
  });

// Push inventory and locations to Google Sheet
const pushToSheet = protectedProcedure
  .output(
    z.object({
      success: z.boolean(),
      inventoryRowCount: z.number(),
      locationRowCount: z.number(),
    }),
  )
  .mutation(async ({ ctx }) => {
    const { client, sheetId, orgMetadata } = await getClientAndSheetId(ctx);

    // Export inventory and locations
    const inventoryRows = await exportInventoryToCSV(
      ctx.db,
      ctx.organizationId,
    );
    const locationRows = await exportLocationsToCSV(ctx.db, ctx.organizationId);

    // Ensure both sheets exist
    await client.ensureSheetExists(sheetId, SHEET_NAMES.INVENTORY);
    await client.ensureSheetExists(sheetId, SHEET_NAMES.LOCATIONS);

    // Write locations first (they may be referenced by inventory)
    const locationDataRows = locationRows.map((row) =>
      LOCATION_CSV_HEADERS.map((h) => toCSVString(row[h as keyof typeof row])),
    );
    await client.writeSheet(
      sheetId,
      [LOCATION_CSV_HEADERS, ...locationDataRows],
      SHEET_NAMES.LOCATIONS,
    );

    // Write inventory
    const inventoryDataRows = inventoryRows.map((row) =>
      INVENTORY_CSV_HEADERS.map((h) => toCSVString(row[h as keyof typeof row])),
    );
    await client.writeSheet(
      sheetId,
      [INVENTORY_CSV_HEADERS, ...inventoryDataRows],
      SHEET_NAMES.INVENTORY,
    );

    await updateLastSyncTimestamp(ctx, orgMetadata);

    return {
      success: true,
      inventoryRowCount: inventoryRows.length,
      locationRowCount: locationRows.length,
    };
  });

// Pull from Google Sheet (preview mode) - combined for both sheets
const pullFromSheet = protectedProcedure
  .output(combinedSyncResult)
  .mutation(async ({ ctx }) => {
    const pullData = await prepareCombinedPullData(ctx);

    // Preview locations import first
    let locationsResult: LocationCSVImportResult;
    if (pullData.locations.parsedRows.length > 0) {
      locationsResult = await importLocationsFromCSV(
        ctx.db,
        ctx.organizationId,
        pullData.locations.parsedRows,
        { dryRun: true },
      );
      // Add error items
      locationsResult = {
        ...locationsResult,
        errors: locationsResult.errors + pullData.locations.errorItems.length,
        items: [...locationsResult.items, ...pullData.locations.errorItems],
      };
    } else {
      locationsResult = EMPTY_LOCATION_RESULT;
    }

    // Preview inventory import
    let inventoryResult: CSVImportResult;
    if (!pullData.inventory.isEmpty) {
      inventoryResult = await importInventoryFromCSV(
        ctx.db,
        ctx.actorContext.organizationId,
        pullData.inventory.parsedRows,
        {
          dryRun: true,
          actor: { ...ctx.actorContext, source: "sheets_import" },
        },
      );
      inventoryResult = buildPullResult(
        inventoryResult,
        pullData.inventory.errorItems,
        pullData.inventory.removedItems,
      );

      // Detect renames from created/removed pairs
      const { items: itemsWithRenames, renameCount } = detectRenamesForPull(
        inventoryResult.items,
        pullData.inventory.parsedRows,
        pullData.inventory.appRows,
      );

      // Update result with rename detection
      if (renameCount > 0) {
        inventoryResult = {
          ...inventoryResult,
          created: inventoryResult.created - renameCount,
          removed: (inventoryResult.removed ?? 0) - renameCount || undefined,
          renamed: renameCount,
          items: itemsWithRenames,
        };
      }
    } else {
      inventoryResult = EMPTY_IMPORT_RESULT;
    }

    return { inventory: inventoryResult, locations: locationsResult };
  });

// Apply pull from Google Sheet - combined for both sheets
const applyPull = protectedProcedure
  .output(combinedSyncResult)
  .mutation(async ({ ctx }) => {
    const pullData = await prepareCombinedPullData(ctx);

    // Import locations FIRST (so they exist for inventory)
    let locationsResult: LocationCSVImportResult;
    if (pullData.locations.parsedRows.length > 0) {
      locationsResult = await importLocationsFromCSV(
        ctx.db,
        ctx.organizationId,
        pullData.locations.parsedRows,
        { dryRun: false },
      );
      locationsResult = {
        ...locationsResult,
        errors: locationsResult.errors + pullData.locations.errorItems.length,
        items: [...locationsResult.items, ...pullData.locations.errorItems],
      };
    } else {
      locationsResult = EMPTY_LOCATION_RESULT;
    }

    // Import inventory
    let inventoryResult: CSVImportResult;
    if (!pullData.inventory.isEmpty) {
      inventoryResult = await importInventoryFromCSV(
        ctx.db,
        ctx.actorContext.organizationId,
        pullData.inventory.parsedRows,
        {
          dryRun: false,
          actor: { ...ctx.actorContext, source: "sheets_import" },
        },
      );

      // Delete inventory entries and products that were removed from the sheet
      for (const item of pullData.inventory.removedItems) {
        if (item.inventoryEntryId) {
          await deleteInventoryEntry(ctx.db, item.inventoryEntryId, {
            ...ctx.actorContext,
            source: "sheets_import",
          });
        } else if (item.productIdToDelete) {
          await deleteProduct(ctx.db, item.productIdToDelete, {
            ...ctx.actorContext,
            source: "sheets_import",
          });
        }
      }

      inventoryResult = buildPullResult(
        inventoryResult,
        pullData.inventory.errorItems,
        pullData.inventory.removedItems,
      );
    } else {
      inventoryResult = EMPTY_IMPORT_RESULT;
    }

    await updateLastSyncTimestamp(ctx, pullData.orgMetadata);
    return { inventory: inventoryResult, locations: locationsResult };
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
