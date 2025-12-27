/**
 * Google Sheets Integration Router
 *
 * Provides omnidirectional sync between app data and Google Sheets:
 * - syncPreview: Compare app and sheet data, show differences with resolution options
 * - applySync: Execute sync with user-selected resolutions for conflicts
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import {
  getGoogleSheetsClient,
  GoogleSheetsClient,
  SHEET_NAMES,
  type ColumnSchema,
} from "~/server/clients/google-sheets";
import { productCategory } from "~/schemas/product";
import { locationType } from "~/schemas/location";
import { exportInventoryToCSV } from "~/server/repo/inventory/csv-export";
import { importInventoryFromCSV } from "~/server/repo/inventory/csv-import";
import { inventoryCSVRow, type InventoryCSVRow } from "~/schemas/inventory";
import { locationCSVRow, type LocationCSVRow } from "~/schemas/location";
import {
  getOrganizationMetadata,
  updateOrganizationMetadata,
} from "~/server/repo/organization";
import { toCSVString } from "~/lib/csv-utils";
// Note: csv-comparison is now only used by the sync repo module
import { exportLocationsToCSV } from "~/server/repo/location/csv-export";
import { importLocationsFromCSV } from "~/server/repo/location/csv-import";
import {
  type OrganizationId,
  unsafeInventoryId,
  unsafeLocationId,
  unsafeProductId,
} from "~/schemas/identifiers";
import { deleteInventoryEntry } from "~/server/repo/inventory";
import {
  deleteLocation,
  updateLocation,
  updateLocationFromSync,
} from "~/server/repo/location";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";

dayjs.extend(customParseFormat);
import { updateProduct } from "~/server/repo/product";
import {
  compareLocationsForSync,
  compareInventoryForSync,
  countByState,
  syncItemsToLocationCSVRows,
  syncItemsToInventoryCSVRows,
} from "~/server/repo/sync";
import {
  syncPreviewResult,
  applySyncInput,
  applySyncResult,
  type LocationSyncItem,
  type InventorySyncItem,
} from "~/schemas/sync";

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

/**
 * Parse date string from Google Sheet into Date object.
 * Handles both app format (YYYY-MM-DD HH:mm:ss) and Sheets format (M/D/YYYY H:mm:ss)
 */
const parseSheetDate = (dateStr: string | null | undefined): Date | null => {
  if (!dateStr) return null;
  const formats = [
    "YYYY-MM-DD HH:mm:ss", // App format
    "M/D/YYYY H:mm:ss", // Sheets format (single digits)
    "MM/DD/YYYY HH:mm:ss", // Sheets format (padded)
  ];
  for (const fmt of formats) {
    const parsed = dayjs(dateStr, fmt, true);
    if (parsed.isValid()) {
      return parsed.toDate();
    }
  }
  // Fallback: try native parsing
  const fallback = dayjs(dateStr);
  return fallback.isValid() ? fallback.toDate() : null;
};

// CSV column headers for Inventory sheet
const INVENTORY_CSV_HEADERS = [
  "product_name",
  "manufacturer",
  "category",
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
  "last_inventory_date",
];

// Column type schemas for Google Sheets formatting
// These define dropdowns, number formats, etc. for each column
// Order must match INVENTORY_CSV_HEADERS
const INVENTORY_COLUMN_SCHEMA: ColumnSchema[] = [
  { header: "product_name", type: { kind: "text" } },
  { header: "manufacturer", type: { kind: "text" } },
  {
    header: "category",
    type: { kind: "dropdown", options: ["", ...productCategory.options] },
  },
  { header: "upc", type: { kind: "text" } },
  { header: "model", type: { kind: "text" } },
  { header: "ndb_number", type: { kind: "number" } },
  { header: "location_name", type: { kind: "text" } },
  { header: "quantity", type: { kind: "number", decimals: 2 } },
  { header: "unit", type: { kind: "text" } },
  { header: "expected_qty", type: { kind: "number" } },
  { header: "price", type: { kind: "currency", decimals: 2 } },
  { header: "unit_mappings", type: { kind: "text" } },
  { header: "ingredient_name", type: { kind: "text" } },
  { header: "aliases", type: { kind: "text" } },
  { header: "product_image", type: { kind: "text" } },
];

const LOCATION_COLUMN_SCHEMA: ColumnSchema[] = [
  { header: "location_name", type: { kind: "text" } },
  { header: "parent_name", type: { kind: "text" } },
  {
    header: "location_type",
    type: { kind: "dropdown", options: ["", ...locationType.options] },
  },
  { header: "description", type: { kind: "text" } },
  { header: "location_image", type: { kind: "text" } },
  { header: "last_inventory_date", type: { kind: "date" } },
];

// Parse currency string to number (handles $, commas, etc.)
function parseCurrency(value: string | undefined): number | undefined {
  if (!value || value.trim() === "") return undefined;
  // Strip currency symbols, commas, and whitespace
  const cleaned = value.replace(/[$,\s]/g, "");
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? undefined : num;
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
  db: Parameters<typeof getOrganizationMetadata>[0];
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

  const org = await getOrganizationMetadata(ctx.db, ctx.organizationId);

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

// Update organization's last sync timestamp
async function updateLastSyncTimestamp(
  ctx: SheetContext,
  existingMetadata: string | null,
): Promise<void> {
  const newMetadata = mergeOrgMetadata(existingMetadata, {
    googleSheetLastSync: new Date().toISOString(),
  });

  await updateOrganizationMetadata(ctx.db, ctx.organizationId, newMetadata);
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
      category: rowObj.category || undefined,
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
      last_inventory_date: rowObj.last_inventory_date || undefined,
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
    const org = await getOrganizationMetadata(ctx.db, ctx.organizationId);

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
    const org = await getOrganizationMetadata(ctx.db, ctx.organizationId);

    // Update metadata with new sheet ID
    const newMetadata = mergeOrgMetadata(org?.metadata ?? null, {
      googleSheetId: sheetId,
      googleSheetLastSync: null, // Reset last sync when changing sheet
    });

    await updateOrganizationMetadata(ctx.db, ctx.organizationId, newMetadata);

    return { success: true };
  });

/** Ensure table schema is applied to a sheet (shared by sync + repair) */
async function ensureTableSchema(
  client: ReturnType<typeof getGoogleSheetsClient>,
  sheetId: string,
  sheetName: string,
  tableName: string,
  columnSchema: ColumnSchema[],
  headers: string[],
  rowCount: number,
): Promise<void> {
  // Write headers if sheet is empty
  if (rowCount === 0) {
    await client.writeSheet(sheetId, [headers], sheetName);
    return; // Can't create table without data rows
  }
  // Create or update table with column types
  await client.createOrUpdateTable(
    sheetId,
    sheetName,
    tableName,
    columnSchema,
    rowCount,
  );
}

// Repair sheet schema - ensures tables exist with proper column types
const repairSheetSchema = protectedProcedure
  .output(
    z.object({
      success: z.boolean(),
      inventoryRowCount: z.number(),
      locationsRowCount: z.number(),
      message: z.string(),
    }),
  )
  .mutation(async ({ ctx }) => {
    const { client, sheetId } = await getClientAndSheetId(ctx);

    // Ensure both sheets exist
    await client.ensureSheetExists(sheetId, SHEET_NAMES.INVENTORY);
    await client.ensureSheetExists(sheetId, SHEET_NAMES.LOCATIONS);

    // Read current data from both sheets to get row counts
    const inventoryData = await client.readSheet(
      sheetId,
      SHEET_NAMES.INVENTORY,
    );
    const locationsData = await client.readSheet(
      sheetId,
      SHEET_NAMES.LOCATIONS,
    );

    const inventoryRowCount = Math.max(0, inventoryData.length - 1);
    const locationsRowCount = Math.max(0, locationsData.length - 1);

    // Apply table schemas
    await ensureTableSchema(
      client,
      sheetId,
      SHEET_NAMES.INVENTORY,
      "inventory",
      INVENTORY_COLUMN_SCHEMA,
      INVENTORY_CSV_HEADERS,
      inventoryRowCount,
    );
    await ensureTableSchema(
      client,
      sheetId,
      SHEET_NAMES.LOCATIONS,
      "locations",
      LOCATION_COLUMN_SCHEMA,
      LOCATION_CSV_HEADERS,
      locationsRowCount,
    );

    const parts = [];
    if (inventoryRowCount > 0)
      parts.push(`Inventory: ${inventoryRowCount} rows`);
    if (locationsRowCount > 0)
      parts.push(`Locations: ${locationsRowCount} rows`);
    const message =
      parts.length > 0
        ? `Schema repaired. ${parts.join(", ")}`
        : "Schema repaired. Both sheets are empty - headers written.";

    return { success: true, inventoryRowCount, locationsRowCount, message };
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

// =============================================================================
// Omnidirectional Sync Endpoints
// =============================================================================

/** Result counters for sync operations */
type SyncResults = {
  locations: {
    created: number;
    updated: number;
    deleted: number;
    errors: number;
  };
  inventory: {
    created: number;
    updated: number;
    deleted: number;
    moved: number;
    errors: number;
  };
  errorMessages: string[];
};

const createEmptySyncResults = (): SyncResults => ({
  locations: { created: 0, updated: 0, deleted: 0, errors: 0 },
  inventory: { created: 0, updated: 0, deleted: 0, moved: 0, errors: 0 },
  errorMessages: [],
});

/**
 * Validate sync resolutions before applying
 * Returns validation errors if any
 */
function validateSyncResolutions(
  locationItems: LocationSyncItem[],
  inventoryItems: InventorySyncItem[],
): {
  message: string;
  itemKey?: string;
  entityType?: "location" | "inventory";
}[] {
  const errors: {
    message: string;
    itemKey?: string;
    entityType?: "location" | "inventory";
  }[] = [];

  // Check all conflicts are resolved
  for (const item of locationItems) {
    if (item.state === "conflict" && !item.resolution) {
      errors.push({
        message: `Location "${item.appData?.locationName ?? item.key}" has a conflict that must be resolved`,
        itemKey: item.key,
        entityType: "location",
      });
    }
  }

  for (const item of inventoryItems) {
    if (item.state === "conflict" && !item.resolution) {
      errors.push({
        message: `Inventory item "${item.appData?.productName ?? item.key}" has a conflict that must be resolved`,
        itemKey: item.key,
        entityType: "inventory",
      });
    }
  }

  // Check location deletions don't orphan inventory
  const locationsBeingDeleted = new Set<string>();
  for (const item of locationItems) {
    if (item.resolution === "delete_from_app" && item.appData?.locationName) {
      locationsBeingDeleted.add(item.appData.locationName.toLowerCase().trim());
    }
  }

  // Check if any inventory items are in locations being deleted
  // but the inventory item itself is not being deleted
  for (const item of inventoryItems) {
    const locationName = item.appData?.locationName?.toLowerCase().trim();
    if (
      locationName &&
      locationsBeingDeleted.has(locationName) &&
      item.resolution !== "delete_from_app"
    ) {
      errors.push({
        message: `Cannot delete location "${item.appData?.locationName}" - inventory item "${item.appData?.productName}" is still there`,
        itemKey: item.key,
        entityType: "inventory",
      });
    }
  }

  return errors;
}

/** Fetch locations from Google Sheet */
async function fetchSheetLocations(
  client: ReturnType<typeof getGoogleSheetsClient>,
  sheetId: string,
): Promise<LocationCSVRow[]> {
  try {
    const sheets = await client.listSheets(sheetId);
    if (sheets.includes(SHEET_NAMES.LOCATIONS)) {
      const data = await client.readSheet(sheetId, SHEET_NAMES.LOCATIONS);
      return parseLocationSheetRows(data).rows;
    }
  } catch {
    // Locations sheet doesn't exist
  }
  return [];
}

/** Process imports from sheet to app (locations and inventory) */
async function processImportsToApp(
  ctx: {
    db: Parameters<typeof importLocationsFromCSV>[0];
    organizationId: OrganizationId;
    actorContext: Parameters<typeof importInventoryFromCSV>[3]["actor"];
  },
  locationItems: LocationSyncItem[],
  inventoryItems: InventorySyncItem[],
  results: SyncResults,
): Promise<void> {
  // Locations to add to app (sheet_only with add_to_app)
  const locationsToAddToApp = locationItems.filter(
    (i) => i.state === "sheet_only" && i.resolution === "add_to_app",
  );

  if (locationsToAddToApp.length > 0) {
    const rows = syncItemsToLocationCSVRows(locationsToAddToApp);
    if (rows.length > 0) {
      const result = await importLocationsFromCSV(
        ctx.db,
        ctx.organizationId,
        rows,
        { dryRun: false },
      );
      results.locations.created += result.created;
      results.locations.updated += result.updated;
      results.locations.errors += result.errors;
    }
  }

  // Locations with conflicts resolved to use_sheet - update existing locations
  const locationsToUpdateFromSheet = locationItems.filter(
    (i) => i.state === "conflict" && i.resolution === "use_sheet",
  );

  for (const item of locationsToUpdateFromSheet) {
    if (!item.appData?.locationId || !item.sheetData) {
      results.locations.errors++;
      continue;
    }

    try {
      await updateLocationFromSync(
        ctx.db,
        unsafeLocationId(item.appData.locationId),
        {
          lastInventoryDate: parseSheetDate(item.sheetData.lastInventoryDate),
          description: item.sheetData.description,
        },
      );
      results.locations.updated++;
    } catch {
      results.locations.errors++;
    }
  }

  // Inventory to add/update in app
  // For "moved" items: both "apply_move" and "use_sheet" mean: use sheet's location
  const inventoryToImport = inventoryItems.filter(
    (i) =>
      (i.state === "sheet_only" && i.resolution === "add_to_app") ||
      (i.state === "conflict" && i.resolution === "use_sheet") ||
      (i.state === "moved" &&
        (i.resolution === "apply_move" || i.resolution === "use_sheet")),
  );

  if (inventoryToImport.length > 0) {
    const rows = syncItemsToInventoryCSVRows(inventoryToImport);
    if (rows.length > 0) {
      const result = await importInventoryFromCSV(
        ctx.db,
        ctx.organizationId,
        rows,
        {
          dryRun: false,
          actor: { ...ctx.actorContext, source: "sheets_import" },
        },
      );
      results.inventory.created += result.created;
      results.inventory.updated += result.updated;
      results.inventory.errors += result.errors;
    }
  }

  // Count moves that were applied
  results.inventory.moved = inventoryItems.filter(
    (i) =>
      i.state === "moved" &&
      (i.resolution === "apply_move" || i.resolution === "use_sheet"),
  ).length;
}

/** Process deletions from app */
async function processAppDeletions(
  ctx: {
    db: Parameters<typeof deleteInventoryEntry>[0];
    actorContext: Parameters<typeof deleteInventoryEntry>[2];
  },
  locationItems: LocationSyncItem[],
  inventoryItems: InventorySyncItem[],
  results: SyncResults,
): Promise<void> {
  // Delete inventory from app
  const inventoryToDelete = inventoryItems.filter(
    (i) => i.state === "app_only" && i.resolution === "delete_from_app",
  );

  for (const item of inventoryToDelete) {
    if (item.appData?.inventoryEntryId) {
      try {
        await deleteInventoryEntry(
          ctx.db,
          unsafeInventoryId(item.appData.inventoryEntryId),
          { ...ctx.actorContext, source: "sheets_import" },
        );
        results.inventory.deleted++;
      } catch (err) {
        results.inventory.errors++;
        results.errorMessages.push(
          `Failed to delete inventory: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    }
  }

  // Delete locations from app
  const locationsToDelete = locationItems.filter(
    (i) => i.state === "app_only" && i.resolution === "delete_from_app",
  );

  for (const item of locationsToDelete) {
    if (item.appData?.locationId) {
      try {
        await deleteLocation(
          ctx.db,
          unsafeLocationId(item.appData.locationId),
          { ...ctx.actorContext, source: "sheets_import" },
        );
        results.locations.deleted++;
      } catch (err) {
        results.locations.errors++;
        results.errorMessages.push(
          `Failed to delete location: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    }
  }
}

/** Process renames (update app to match sheet names) */
async function processRenames(
  ctx: {
    db: Parameters<typeof updateProduct>[0];
    actorContext: Parameters<typeof updateProduct>[3];
  },
  locationItems: LocationSyncItem[],
  inventoryItems: InventorySyncItem[],
  results: SyncResults,
): Promise<void> {
  // Inventory renames (update product name)
  // Both "apply_rename" and "use_sheet" mean: use sheet's name
  const inventoryRenames = inventoryItems.filter(
    (i) =>
      i.state === "renamed" &&
      (i.resolution === "apply_rename" || i.resolution === "use_sheet"),
  );

  for (const item of inventoryRenames) {
    if (item.appData?.productId && item.sheetData?.productName) {
      try {
        await updateProduct(
          ctx.db,
          unsafeProductId(item.appData.productId),
          { name: item.sheetData.productName },
          { ...ctx.actorContext, source: "sheets_import" },
        );
        results.inventory.updated++;
      } catch (err) {
        results.inventory.errors++;
        results.errorMessages.push(
          `Failed to rename product: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    }
  }

  // Location renames
  const locationRenames = locationItems.filter(
    (i) =>
      i.state === "renamed" &&
      (i.resolution === "apply_rename" || i.resolution === "use_sheet"),
  );

  for (const item of locationRenames) {
    if (item.appData?.locationId && item.sheetData?.locationName) {
      try {
        await updateLocation(
          ctx.db,
          unsafeLocationId(item.appData.locationId),
          { name: item.sheetData.locationName },
          { ...ctx.actorContext, source: "sheets_import" },
        );
        results.locations.updated++;
      } catch (err) {
        results.locations.errors++;
        results.errorMessages.push(
          `Failed to rename location: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    }
  }
}

/** Push location changes to Google Sheet */
async function pushLocationsToSheet(
  client: ReturnType<typeof getGoogleSheetsClient>,
  sheetId: string,
  locationItems: LocationSyncItem[],
  sheetLocations: LocationCSVRow[],
  results: SyncResults,
): Promise<void> {
  // Items to add/update in sheet
  const locationsToAddToSheet = locationItems.filter(
    (i) =>
      (i.state === "app_only" && i.resolution === "add_to_sheet") ||
      (i.state === "conflict" && i.resolution === "use_app") ||
      (i.state === "renamed" && i.resolution === "use_app"),
  );

  const locationsToDeleteFromSheet = locationItems.filter(
    (i) => i.state === "sheet_only" && i.resolution === "delete_from_sheet",
  );

  const locationsToUpdateFromSheet = locationItems.filter(
    (i) => i.state === "conflict" && i.resolution === "use_sheet",
  );

  const renamedLocationsUseApp = locationItems.filter(
    (i) => i.state === "renamed" && i.resolution === "use_app",
  );

  if (
    locationsToAddToSheet.length === 0 &&
    locationsToDeleteFromSheet.length === 0 &&
    locationsToUpdateFromSheet.length === 0 &&
    renamedLocationsUseApp.length === 0
  ) {
    return;
  }

  // Build keys to filter out
  const deleteKeys = new Set(locationsToDeleteFromSheet.map((i) => i.key));
  const updateKeys = new Set(
    locationItems
      .filter((i) => i.state === "conflict" && i.resolution === "use_app")
      .map((i) => i.key),
  );
  const renamedSheetKeys = new Set(
    renamedLocationsUseApp
      .filter((i) => i.sheetData)
      .map((i) => i.sheetData!.locationName.toLowerCase().trim()),
  );

  // Count updates to sheet
  results.locations.updated += updateKeys.size + renamedLocationsUseApp.length;

  // Rebuild sheet rows
  const updatedRows = [
    ...sheetLocations.filter((row) => {
      const key = row.location_name.toLowerCase().trim();
      return (
        !deleteKeys.has(key) &&
        !updateKeys.has(key) &&
        !renamedSheetKeys.has(key)
      );
    }),
    ...syncItemsToLocationCSVRows(locationsToAddToSheet, true),
  ];

  // Write to sheet
  const dataRows = updatedRows.map((row) =>
    LOCATION_CSV_HEADERS.map((h) => toCSVString(row[h as keyof typeof row])),
  );
  await client.writeSheet(
    sheetId,
    [LOCATION_CSV_HEADERS, ...dataRows],
    SHEET_NAMES.LOCATIONS,
  );

  // Apply table schema
  await ensureTableSchema(
    client,
    sheetId,
    SHEET_NAMES.LOCATIONS,
    "locations",
    LOCATION_COLUMN_SCHEMA,
    LOCATION_CSV_HEADERS,
    dataRows.length,
  );
}

/** Push inventory changes to Google Sheet */
async function pushInventoryToSheet(
  client: ReturnType<typeof getGoogleSheetsClient>,
  sheetId: string,
  inventoryItems: InventorySyncItem[],
  sheetInventory: InventoryCSVRow[],
  results: SyncResults,
): Promise<void> {
  const inventoryToAddToSheet = inventoryItems.filter(
    (i) =>
      (i.state === "app_only" && i.resolution === "add_to_sheet") ||
      (i.state === "conflict" && i.resolution === "use_app") ||
      (i.state === "moved" && i.resolution === "use_app") ||
      (i.state === "renamed" && i.resolution === "use_app"),
  );

  const inventoryToDeleteFromSheet = inventoryItems.filter(
    (i) => i.state === "sheet_only" && i.resolution === "delete_from_sheet",
  );

  const movedOrRenamedUseApp = inventoryItems.filter(
    (i) =>
      (i.state === "moved" || i.state === "renamed") &&
      i.resolution === "use_app",
  );

  if (
    inventoryToAddToSheet.length === 0 &&
    inventoryToDeleteFromSheet.length === 0 &&
    movedOrRenamedUseApp.length === 0
  ) {
    return;
  }

  // Build keys to filter out
  const deleteKeys = new Set(inventoryToDeleteFromSheet.map((i) => i.key));
  const updateKeys = new Set(
    inventoryItems
      .filter((i) => i.state === "conflict" && i.resolution === "use_app")
      .map((i) => i.key),
  );
  const sheetKeysToDelete = new Set(
    movedOrRenamedUseApp
      .filter((i) => i.sheetData)
      .map((i) => {
        const sd = i.sheetData!;
        return `${(sd.productName ?? "").toLowerCase().trim()}|${((sd.manufacturer as string | null) ?? "(unspecified)").toLowerCase().trim()}|${(sd.locationName ?? "").toLowerCase().trim()}`;
      }),
  );

  // Keep sheet rows not being deleted/updated
  const keptRows = sheetInventory.filter((row) => {
    const key = `${row.product_name.toLowerCase().trim()}|${(row.manufacturer ?? "(unspecified)").toLowerCase().trim()}|${(row.location_name ?? "").toLowerCase().trim()}`;
    return (
      !deleteKeys.has(key) &&
      !updateKeys.has(key) &&
      !sheetKeysToDelete.has(key)
    );
  });

  // Count updates to sheet
  results.inventory.updated += updateKeys.size + movedOrRenamedUseApp.length;

  // Rebuild sheet rows
  const updatedRows = [
    ...keptRows,
    ...syncItemsToInventoryCSVRows(inventoryToAddToSheet, true),
  ];

  // Write to sheet
  const dataRows = updatedRows.map((row) =>
    INVENTORY_CSV_HEADERS.map((h) => toCSVString(row[h as keyof typeof row])),
  );
  await client.writeSheet(
    sheetId,
    [INVENTORY_CSV_HEADERS, ...dataRows],
    SHEET_NAMES.INVENTORY,
  );

  // Apply table schema
  await ensureTableSchema(
    client,
    sheetId,
    SHEET_NAMES.INVENTORY,
    "inventory",
    INVENTORY_COLUMN_SCHEMA,
    INVENTORY_CSV_HEADERS,
    dataRows.length,
  );
}

// Sync preview - unified comparison of app and sheet
const syncPreview = protectedProcedure
  .output(syncPreviewResult)
  .mutation(async ({ ctx }) => {
    const { client, sheetId } = await getClientAndSheetId(ctx);

    // Fetch app data
    const appLocations = await exportLocationsToCSV(ctx.db, ctx.organizationId);
    const appInventory = await exportInventoryToCSV(ctx.db, ctx.organizationId);

    // Fetch sheet data
    const sheetLocations = await fetchSheetLocations(client, sheetId);
    const inventorySheetData = await client.readSheet(
      sheetId,
      SHEET_NAMES.INVENTORY,
    );
    const sheetInventory = parseSheetRows(inventorySheetData).rows;

    // Compare
    const locationItems = compareLocationsForSync(appLocations, sheetLocations);
    const inventoryItems = compareInventoryForSync(
      appInventory,
      sheetInventory,
    );

    // Count by state
    const locationCounts = countByState(locationItems);
    const inventoryCounts = countByState(inventoryItems);

    // Validate
    const validationErrors = validateSyncResolutions(
      locationItems,
      inventoryItems,
    );

    // Check if can apply (no unresolved conflicts)
    const hasUnresolvedConflicts =
      locationItems.some((i) => i.state === "conflict" && !i.resolution) ||
      inventoryItems.some((i) => i.state === "conflict" && !i.resolution);

    // Check if there are any changes to apply (anything not matched)
    const hasChangesToApply =
      locationCounts.conflict > 0 ||
      locationCounts.app_only > 0 ||
      locationCounts.sheet_only > 0 ||
      locationCounts.renamed > 0 ||
      inventoryCounts.conflict > 0 ||
      inventoryCounts.app_only > 0 ||
      inventoryCounts.sheet_only > 0 ||
      inventoryCounts.renamed > 0 ||
      inventoryCounts.moved > 0;

    return {
      locations: {
        items: locationItems,
        matched: locationCounts.matched,
        conflicts: locationCounts.conflict,
        appOnly: locationCounts.app_only,
        sheetOnly: locationCounts.sheet_only,
        renamed: locationCounts.renamed,
      },
      inventory: {
        items: inventoryItems,
        matched: inventoryCounts.matched,
        conflicts: inventoryCounts.conflict,
        appOnly: inventoryCounts.app_only,
        sheetOnly: inventoryCounts.sheet_only,
        renamed: inventoryCounts.renamed,
        moved: inventoryCounts.moved,
      },
      validationErrors,
      canApply:
        hasChangesToApply &&
        !hasUnresolvedConflicts &&
        validationErrors.length === 0,
    };
  });

// Apply sync - execute the sync with user resolutions
const applySync = protectedProcedure
  .input(applySyncInput)
  .output(applySyncResult)
  .mutation(async ({ ctx, input }) => {
    const { client, sheetId, orgMetadata } = await getClientAndSheetId(ctx);

    // Fetch current state from both sides
    const appLocations = await exportLocationsToCSV(ctx.db, ctx.organizationId);
    const appInventory = await exportInventoryToCSV(ctx.db, ctx.organizationId);
    const sheetLocations = await fetchSheetLocations(client, sheetId);
    const inventorySheetData = await client.readSheet(
      sheetId,
      SHEET_NAMES.INVENTORY,
    );
    const sheetInventory = parseSheetRows(inventorySheetData).rows;

    // Compare and apply user resolutions
    const locationItems = compareLocationsForSync(appLocations, sheetLocations);
    const inventoryItems = compareInventoryForSync(
      appInventory,
      sheetInventory,
    );

    for (const item of locationItems) {
      const userResolution = input.locationResolutions[item.key];
      if (userResolution) item.resolution = userResolution;
    }
    for (const item of inventoryItems) {
      const userResolution = input.inventoryResolutions[item.key];
      if (userResolution) item.resolution = userResolution;
    }

    // Validate resolutions
    const validationErrors = validateSyncResolutions(
      locationItems,
      inventoryItems,
    );
    if (validationErrors.length > 0) {
      return {
        ...createEmptySyncResults(),
        success: false,
        errorMessages: validationErrors.map((e) => e.message),
      };
    }

    // Execute sync operations
    const results = createEmptySyncResults();

    // Process locations first (inventory may reference them)
    await processImportsToApp(
      {
        db: ctx.db,
        organizationId: ctx.organizationId,
        actorContext: ctx.actorContext,
      },
      locationItems,
      inventoryItems,
      results,
    );

    // Process deletions from app
    await processAppDeletions(
      { db: ctx.db, actorContext: ctx.actorContext },
      locationItems,
      inventoryItems,
      results,
    );

    // Process renames (app → sheet name)
    await processRenames(
      { db: ctx.db, actorContext: ctx.actorContext },
      locationItems,
      inventoryItems,
      results,
    );

    // Push changes to sheets
    await pushLocationsToSheet(
      client,
      sheetId,
      locationItems,
      sheetLocations,
      results,
    );
    await pushInventoryToSheet(
      client,
      sheetId,
      inventoryItems,
      sheetInventory,
      results,
    );

    await updateLastSyncTimestamp(ctx, orgMetadata);

    return {
      ...results,
      success: results.errorMessages.length === 0,
    };
  });

export const googleSheetsRouter = createTRPCRouter({
  getConnectionStatus,
  testConnection,
  updateSheetConnection,
  repairSheetSchema,
  // Unified sync
  syncPreview,
  applySync,
  // Debug
  debugSheetData,
});
