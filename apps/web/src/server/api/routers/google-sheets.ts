/**
 * Google Sheets Integration Router
 *
 * Provides omnidirectional sync between app data and Google Sheets:
 * - syncPreview: Compare app and sheet data, show differences with resolution options
 * - applySync: Execute sync with user-selected resolutions for conflicts
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { toCSVString } from "~/lib/csv-utils";
import { getErrorMessage } from "~/lib/error-utils";
import {
  type IngredientId,
  unsafeInventoryId,
  unsafeLocationId,
  unsafeProductId,
} from "~/schemas/identifiers";
import { type InventoryCSVRow, inventoryCSVRow } from "~/schemas/inventory";
import {
  type LocationCSVRow,
  locationCSVRow,
  locationType,
} from "~/schemas/location";
import { productCategory } from "~/schemas/product";
import {
  applySyncInput,
  applySyncResult,
  type InventorySyncItem,
  type LocationSyncItem,
  syncPreviewResult,
} from "~/schemas/sync";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import {
  type ColumnSchema,
  GoogleSheetsClient,
  getGoogleSheetsClient,
  SHEET_NAMES,
} from "~/server/clients/google-sheets";
import type { Database } from "~/server/db";
import {
  getAppSettings,
  updateAppSettingsMetadata,
} from "~/server/repo/app-settings";
import { withTransaction } from "~/server/repo/database-helpers";
import { getIngredientByName } from "~/server/repo/ingredient";
import {
  deleteInventoryEntries,
  updateInventoryEntry,
} from "~/server/repo/inventory";
import { exportInventoryToCSV } from "~/server/repo/inventory/csv-export";
import {
  createOrUpdatePriceMapping,
  createUnitMappingsFromString,
  importInventoryFromCSV,
} from "~/server/repo/inventory/csv-import";
import { deleteLocations, updateLocation } from "~/server/repo/location";
// Note: csv-comparison is now only used by the sync repo module
import { exportLocationsToCSV } from "~/server/repo/location/csv-export";
import { importLocationsFromCSV } from "~/server/repo/location/csv-import";
import { syncProductPrice, updateProduct } from "~/server/repo/product";
import {
  compareInventoryForSync,
  compareLocationsForSync,
  countByState,
  makeInventoryKey,
  syncItemsToInventoryCSVRows,
  syncItemsToLocationCSVRows,
} from "~/server/repo/sync";
import { SYNC_TIMESTAMPS } from "~/server/repo/sync/config";
import { generateSnapshotHash } from "~/server/repo/sync/snapshot";
import { TraceNames, withTrace } from "~/server/tracing";

// Schema for app settings with Google Sheets config
const googleSheetsMetadata = z.object({
  googleSheetId: z.string().nullable().optional(),
  googleSheetLastSync: z.string().nullable().optional(),
});

type GoogleSheetsMetadata = z.infer<typeof googleSheetsMetadata>;

// Parse app settings metadata to extract Google Sheets config
function parseAppMetadata(
  metadata: Record<string, unknown> | null,
): GoogleSheetsMetadata {
  if (!metadata) return {};
  try {
    return googleSheetsMetadata.parse(metadata);
  } catch {
    return {};
  }
}

// Merge new metadata with existing, preserving other fields
function mergeAppMetadata(
  existing: Record<string, unknown> | null,
  updates: Partial<GoogleSheetsMetadata>,
): string {
  const current = existing ?? {};
  return JSON.stringify({ ...current, ...updates });
}

// Column schemas for Google Sheets formatting
// These define column order, dropdowns, number formats, etc.
// To reorder columns, just reorder these arrays - headers are derived automatically
const INVENTORY_COLUMN_SCHEMA: ColumnSchema[] = [
  { header: "product_name", type: { kind: "text" } },
  { header: "product_shortcode", type: { kind: "text" } },
  { header: "manufacturer", type: { kind: "text" } },
  {
    header: "category",
    type: { kind: "dropdown", options: ["", ...productCategory.options] },
  },
  { header: "upc", type: { kind: "text" } },
  { header: "model", type: { kind: "text" } },
  { header: "ndb_number", type: { kind: "number" } },
  { header: "location_name", type: { kind: "text" } },
  { header: "location_shortcode", type: { kind: "text" } },
  { header: "quantity", type: { kind: "number", decimals: 2 } },
  { header: "unit", type: { kind: "text" } },
  { header: "expected_qty", type: { kind: "number" } },
  { header: "price", type: { kind: "currency", decimals: 2 } },
  { header: "unit_mappings", type: { kind: "text" } },
  { header: "ingredient_name", type: { kind: "text" } },
  { header: "aliases", type: { kind: "text" } },
  { header: "product_image", type: { kind: "text" } },
  // Timestamp columns (only if feature flag enabled)
  ...(SYNC_TIMESTAMPS
    ? [
        { header: "product_created_at", type: { kind: "datetime" } } as const,
        { header: "product_updated_at", type: { kind: "datetime" } } as const,
        { header: "inventory_created_at", type: { kind: "datetime" } } as const,
        { header: "inventory_updated_at", type: { kind: "datetime" } } as const,
      ]
    : []),
  { header: "notes", type: { kind: "text" } },
];

const LOCATION_COLUMN_SCHEMA: ColumnSchema[] = [
  { header: "location_name", type: { kind: "text" } },
  { header: "location_shortcode", type: { kind: "text" } },
  { header: "parent_name", type: { kind: "text" } },
  {
    header: "location_type",
    type: { kind: "dropdown", options: ["", ...locationType.options] },
  },
  { header: "description", type: { kind: "text" } },
  { header: "location_image", type: { kind: "text" } },
  { header: "last_inventory_date", type: { kind: "datetime" } },
  // Timestamp columns (only if feature flag enabled)
  ...(SYNC_TIMESTAMPS
    ? [
        { header: "location_created_at", type: { kind: "datetime" } } as const,
        { header: "location_updated_at", type: { kind: "datetime" } } as const,
      ]
    : []),
];

// Derive CSV headers from column schemas (single source of truth)
const INVENTORY_CSV_HEADERS = INVENTORY_COLUMN_SCHEMA.map((col) => col.header);
const LOCATION_CSV_HEADERS = LOCATION_COLUMN_SCHEMA.map((col) => col.header);

/**
 * Resolve column order for export:
 * - If sheet has existing headers, use that order (preserves user's custom ordering)
 * - Append any new columns from schema that don't exist in sheet
 * - Preserve any custom columns in sheet not in schema
 * - Fallback to schema order for new sheets
 */
function resolveColumnOrder(
  schemaHeaders: readonly string[],
  sheetHeaders: string[] | null,
): string[] {
  // New sheet: use schema order
  if (!sheetHeaders || sheetHeaders.length === 0) {
    return [...schemaHeaders];
  }

  // Normalize sheet headers (match import normalization: lowercase, trim, spaces → underscores)
  const normalizedSheetHeaders = sheetHeaders.map((h) =>
    h.toLowerCase().trim().replace(/\s+/g, "_"),
  );

  // Start with existing sheet order
  const finalOrder = [...normalizedSheetHeaders];

  // Append new columns from schema that don't exist in sheet
  for (const schemaHeader of schemaHeaders) {
    if (!normalizedSheetHeaders.includes(schemaHeader)) {
      finalOrder.push(schemaHeader);
    }
  }

  return finalOrder;
}

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
  db: Parameters<typeof getAppSettings>[0];
};

// Get configured client and validated sheet ID, or throw appropriate error
async function getClientAndSheetId(ctx: SheetContext): Promise<{
  client: ReturnType<typeof getGoogleSheetsClient>;
  sheetId: string;
  appMetadata: Record<string, unknown> | null;
}> {
  return withTrace(
    TraceNames.api("googleSheets", "getClientAndSheetId"),
    async () => {
      const client = getGoogleSheetsClient();

      if (!client.isConfigured()) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Google Sheets integration is not configured",
        });
      }

      const settings = await getAppSettings(ctx.db);

      const metadata = parseAppMetadata(settings.metadata);
      const sheetId = metadata.googleSheetId;

      if (!sheetId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "No Google Sheet connected. Please connect a sheet first.",
        });
      }

      return { client, sheetId, appMetadata: settings.metadata };
    },
  );
}

// Update app settings' last sync timestamp
async function updateLastSyncTimestamp(
  ctx: SheetContext,
  existingMetadata: Record<string, unknown> | null,
): Promise<void> {
  const newMetadata = mergeAppMetadata(existingMetadata, {
    googleSheetLastSync: new Date().toISOString(),
  });

  await updateAppSettingsMetadata(ctx.db, newMetadata);
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
      product_shortcode: rowObj.product_shortcode || undefined,
      manufacturer: rowObj.manufacturer || undefined,
      category: rowObj.category || undefined,
      upc: rowObj.upc || rowObj.barcode || undefined,
      model: rowObj.model || undefined,
      ndb_number: rowObj.ndb_number || rowObj.ndbnumber || undefined,
      location_name: rowObj.location_name || rowObj.location || undefined,
      location_shortcode: rowObj.location_shortcode || undefined,
      quantity: rowObj.quantity || rowObj.qty || 1,
      unit: rowObj.unit || "each",
      expected_qty: rowObj.expected_qty || rowObj.expectedqty || undefined,
      price: parseCurrency(rowObj.price),
      unit_mappings: rowObj.unit_mappings || rowObj.unitmappings || undefined,
      ingredient_name: rowObj.ingredient_name || undefined,
      ingredient: rowObj.ingredient,
      aliases: rowObj.aliases || undefined,
      notes: rowObj.notes || undefined,
      // Timestamps (optional - only parsed if present in sheet)
      product_created_at: rowObj.product_created_at || undefined,
      product_updated_at: rowObj.product_updated_at || undefined,
      inventory_created_at: rowObj.inventory_created_at || undefined,
      inventory_updated_at: rowObj.inventory_updated_at || undefined,
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
      location_shortcode: rowObj.location_shortcode || undefined,
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

    // Get app settings metadata
    const settings = await getAppSettings(ctx.db);

    const metadata = parseAppMetadata(settings.metadata);
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

// Save sheet connection to app settings
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
    const settings = await getAppSettings(ctx.db);

    // Update metadata with new sheet ID
    const newMetadata = mergeAppMetadata(settings.metadata, {
      googleSheetId: sheetId,
      googleSheetLastSync: null, // Reset last sync when changing sheet
    });

    await updateAppSettingsMetadata(ctx.db, newMetadata);

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
  // Write headers if sheet has no data rows
  if (rowCount === 0) {
    // Read existing headers to preserve user's custom column ordering
    // (handles case where user deleted all data rows but kept headers)
    const existingHeaders = await client.readHeaderRow(sheetId, sheetName);
    const columnOrder = resolveColumnOrder(headers, existingHeaders);
    await client.writeSheet(sheetId, [columnOrder], sheetName);
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

/**
 * Update an existing product with sheet data
 *
 * Used when resolving conflicts with "use_sheet" - we need to update
 * the existing product directly rather than going through CSV import
 * (which would fail to find the product due to manufacturer mismatch)
 */
async function updateProductFromSheetData(
  db: Database,
  productId: string,
  sheetData: {
    productName?: string;
    manufacturer?: string | null;
    category?: string | null;
    upc?: string | null;
    model?: string | null;
    ndbNumber?: number | null;
    expectedQty?: number | null;
    price?: number | null;
    unitMappings?: string | null;
    ingredientName?: string | null;
  },
  actorContext: Parameters<typeof updateProduct>[3],
): Promise<void> {
  // Map sheet data fields to ProductCreateInput fields
  const updateData: {
    name?: string;
    manufacturer?: string;
    category?:
      | "food"
      | "tools"
      | "tool-consumables"
      | "tool-accessories"
      | "storage"
      | "hardware"
      | "electronics"
      | "household"
      | "supplies"
      | null;
    upc?: string | null;
    model?: string | null;
    ndb_number?: number | null;
    expectedQuantity?: number | null;
    ingredientId?: IngredientId | null;
  } = {};

  if (sheetData.productName !== undefined) {
    updateData.name = sheetData.productName;
  }
  if (sheetData.manufacturer !== undefined) {
    updateData.manufacturer = sheetData.manufacturer ?? "(unspecified)";
  }
  if (sheetData.category !== undefined) {
    // Validate category is one of the allowed values
    const validCategories = [
      "food",
      "tools",
      "tool-consumables",
      "tool-accessories",
      "storage",
      "hardware",
      "electronics",
      "household",
      "supplies",
    ] as const;
    if (
      sheetData.category === null ||
      validCategories.includes(
        sheetData.category as (typeof validCategories)[number],
      )
    ) {
      updateData.category = sheetData.category as typeof updateData.category;
    }
  }
  if (sheetData.upc !== undefined) {
    updateData.upc = sheetData.upc;
  }
  if (sheetData.model !== undefined) {
    updateData.model = sheetData.model;
  }
  if (sheetData.ndbNumber !== undefined) {
    updateData.ndb_number = sheetData.ndbNumber;
  }
  if (sheetData.expectedQty !== undefined) {
    updateData.expectedQuantity = sheetData.expectedQty;
  }

  // Handle ingredient linking by name lookup
  if (sheetData.ingredientName !== undefined) {
    if (sheetData.ingredientName === null || sheetData.ingredientName === "") {
      // Clear ingredient link if sheet has empty ingredient name
      updateData.ingredientId = null;
    } else {
      // Look up ingredient by name
      try {
        const ingredient = await getIngredientByName(
          db,
          sheetData.ingredientName,
        );
        if (ingredient) {
          updateData.ingredientId = ingredient.id;
        }
        // If ingredient not found, leave ingredientId unchanged (don't clear existing link)
      } catch (error) {
        // Ingredient lookup failed - log but don't fail the entire sync
        console.warn(
          `Failed to link ingredient "${sheetData.ingredientName}" for product ${productId}:`,
          error,
        );
      }
    }
  }

  // Update product fields if any changed
  if (Object.keys(updateData).length > 0) {
    await updateProduct(db, unsafeProductId(productId), updateData, {
      ...actorContext,
      source: "sheets_import",
    });
  }

  // Handle price separately via unit mappings (price is stored as a unit mapping, not a product field)
  // Use transaction to ensure price mapping and product.price column are updated atomically
  const priceValue = sheetData.price;
  if (priceValue !== undefined && priceValue !== null) {
    await withTransaction(db, async (tx) => {
      await createOrUpdatePriceMapping(
        tx,
        unsafeProductId(productId),
        { value: priceValue, unit: "dollar" },
        "sheets_import",
      );
      // Sync the product.price column from the unit mapping
      await syncProductPrice(tx, unsafeProductId(productId));
    });
  }

  // Handle unit mappings if provided
  // Parse and update unit conversions (e.g., "1 whole = 2 oz; 1 cup = 120g")
  if (sheetData.unitMappings) {
    await createUnitMappingsFromString(
      db,
      unsafeProductId(productId),
      sheetData.unitMappings,
    );
  }
}

/** Process imports from sheet to app (locations and inventory) */
async function processImportsToApp(
  ctx: {
    db: Parameters<typeof importLocationsFromCSV>[0];
    actorContext: Parameters<typeof importInventoryFromCSV>[2]["actor"];
  },
  locationItems: LocationSyncItem[],
  inventoryItems: InventorySyncItem[],
  results: SyncResults,
): Promise<void> {
  // Locations to import: sheet_only→add_to_app OR conflict→use_sheet
  // The import function handles both creation and updates
  const locationsToImport = locationItems.filter(
    (i) =>
      (i.state === "sheet_only" && i.resolution === "add_to_app") ||
      (i.state === "conflict" && i.resolution === "use_sheet"),
  );

  if (locationsToImport.length > 0) {
    const rows = syncItemsToLocationCSVRows(locationsToImport);
    if (rows.length > 0) {
      const result = await importLocationsFromCSV(ctx.db, rows, {
        dryRun: false,
      });
      results.locations.created += result.created;
      results.locations.updated += result.updated;
      results.locations.errors += result.errors;
      // Collect error messages from failed items
      for (const item of result.items) {
        if (item.action === "error" && item.message) {
          results.errorMessages.push(
            `Location "${item.locationName}": ${item.message}`,
          );
        }
      }
    }
  }

  // Handle conflicts with "use_sheet" - update existing products and inventory entries
  // This is needed because the product may have a different manufacturer in the app
  // and the standard CSV import looks up by name+manufacturer (would create duplicate)
  const inventoryConflictsUseSheet = inventoryItems.filter(
    (i) => i.state === "conflict" && i.resolution === "use_sheet",
  );

  for (const item of inventoryConflictsUseSheet) {
    if (item.appData?.productId && item.sheetData) {
      try {
        // Update product fields (name, manufacturer, price, etc.)
        await updateProductFromSheetData(
          ctx.db,
          item.appData.productId,
          item.sheetData,
          ctx.actorContext,
        );

        // Update inventory entry fields (quantity) if we have an inventory entry
        if (
          item.appData.inventoryEntryId &&
          item.sheetData.quantity !== undefined
        ) {
          await updateInventoryEntry(
            ctx.db,
            unsafeInventoryId(item.appData.inventoryEntryId),
            {
              amount: {
                value: item.sheetData.quantity ?? 1,
                unit: item.sheetData.unit ?? item.appData.unit ?? "each",
              },
            },
            { ...ctx.actorContext, source: "sheets_import" },
          );
        }

        results.inventory.updated++;
      } catch (error) {
        console.error("Failed to update from sheet data:", error);
        results.inventory.errors++;
        results.errorMessages.push(
          `Inventory "${item.appData.productName}": ${getErrorMessage(error)}`,
        );
      }
    }
  }

  // Inventory to add/update in app (excluding conflicts which are handled above)
  // For "moved" items: both "apply_move" and "use_sheet" mean: use sheet's location
  // BUT: if moved to empty location (movedTo is empty/undefined), treat as deletion instead
  const inventoryToImport = inventoryItems.filter(
    (i) =>
      (i.state === "sheet_only" && i.resolution === "add_to_app") ||
      (i.state === "moved" &&
        (i.resolution === "apply_move" || i.resolution === "use_sheet") &&
        // Only import moves that have a destination location
        // Moves to "(none)" will be handled as deletions below
        i.sheetData?.locationName &&
        i.sheetData.locationName.trim() !== ""),
  );

  if (inventoryToImport.length > 0) {
    const rows = syncItemsToInventoryCSVRows(inventoryToImport);
    if (rows.length > 0) {
      const result = await importInventoryFromCSV(ctx.db, rows, {
        dryRun: false,
        actor: { ...ctx.actorContext, source: "sheets_import" },
      });
      results.inventory.created += result.created;
      results.inventory.updated += result.updated;
      results.inventory.errors += result.errors;
      // Collect error messages from failed items
      for (const item of result.items) {
        if (item.action === "error" && item.message) {
          results.errorMessages.push(
            `Inventory "${item.productName}": ${item.message}`,
          );
        }
      }
    }
  }

  // Count moves that were applied (excluding moves to empty location, which are deletions)
  results.inventory.moved = inventoryItems.filter(
    (i) =>
      i.state === "moved" &&
      (i.resolution === "apply_move" || i.resolution === "use_sheet") &&
      i.sheetData?.locationName &&
      i.sheetData.locationName.trim() !== "",
  ).length;
}

/** Process deletions from app */
async function processAppDeletions(
  ctx: {
    db: Parameters<typeof deleteInventoryEntries>[0];
    actorContext: Parameters<typeof deleteInventoryEntries>[2];
  },
  locationItems: LocationSyncItem[],
  inventoryItems: InventorySyncItem[],
  results: SyncResults,
): Promise<void> {
  // Collect inventory IDs to delete
  const inventoryIds = inventoryItems
    .filter(
      (i) =>
        // Explicit deletions
        (i.state === "app_only" && i.resolution === "delete_from_app") ||
        // Moves to empty location (no location = no inventory, since locationId is NOT NULL)
        (i.state === "moved" &&
          (i.resolution === "apply_move" || i.resolution === "use_sheet") &&
          (!i.sheetData?.locationName ||
            i.sheetData.locationName.trim() === "")),
    )
    .map((i) => i.appData?.inventoryEntryId)
    .filter((id): id is NonNullable<typeof id> => id !== undefined)
    .map((id) => unsafeInventoryId(id));

  if (inventoryIds.length > 0) {
    try {
      await deleteInventoryEntries(ctx.db, inventoryIds, {
        ...ctx.actorContext,
        source: "sheets_import",
      });
      results.inventory.deleted += inventoryIds.length;
    } catch (err) {
      results.inventory.errors += inventoryIds.length;
      results.errorMessages.push(
        `Failed to delete ${inventoryIds.length} inventory entries: ${getErrorMessage(err)}`,
      );
    }
  }

  // Collect location IDs to delete
  const locationIds = locationItems
    .filter((i) => i.state === "app_only" && i.resolution === "delete_from_app")
    .map((i) => i.appData?.locationId)
    .filter((id): id is NonNullable<typeof id> => id !== undefined)
    .map((id) => unsafeLocationId(id));

  if (locationIds.length > 0) {
    try {
      await deleteLocations(ctx.db, locationIds, {
        ...ctx.actorContext,
        source: "sheets_import",
      });
      results.locations.deleted += locationIds.length;
    } catch (err) {
      results.locations.errors += locationIds.length;
      results.errorMessages.push(
        `Failed to delete ${locationIds.length} locations: ${getErrorMessage(err)}`,
      );
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
          `Failed to rename product: ${getErrorMessage(err)}`,
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
          `Failed to rename location: ${getErrorMessage(err)}`,
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
  const conflictUpdates = locationItems.filter(
    (i) => i.state === "conflict" && i.resolution === "use_app",
  ).length;
  results.locations.updated += conflictUpdates + renamedLocationsUseApp.length;

  // Build parent_name rename map: old sheet name → new app name
  // When a parent is renamed with "use_app", child rows still reference the old parent_name
  const parentRenameMap = new Map<string, string>();
  for (const item of renamedLocationsUseApp) {
    if (item.renamedTo && item.renamedFrom) {
      parentRenameMap.set(
        item.renamedTo.toLowerCase().trim(),
        item.renamedFrom,
      );
    }
  }

  // Rebuild sheet rows
  const updatedRows = [
    ...sheetLocations
      .filter((row) => {
        const key = row.location_name.toLowerCase().trim();
        return (
          !deleteKeys.has(key) &&
          !updateKeys.has(key) &&
          !renamedSheetKeys.has(key)
        );
      })
      .map((row) => {
        // Cascade parent_name updates for renamed locations
        if (row.parent_name && parentRenameMap.size > 0) {
          const newParent = parentRenameMap.get(
            row.parent_name.toLowerCase().trim(),
          );
          if (newParent) {
            return { ...row, parent_name: newParent };
          }
        }
        return row;
      }),
    ...syncItemsToLocationCSVRows(locationsToAddToSheet, true),
  ];

  // Read existing headers to preserve user's column ordering
  const existingHeaders = await client.readHeaderRow(
    sheetId,
    SHEET_NAMES.LOCATIONS,
  );

  // Resolve column order (preserves user's ordering, appends new columns)
  const columnOrder = resolveColumnOrder(LOCATION_CSV_HEADERS, existingHeaders);

  // Write to sheet using resolved column order
  const dataRows = updatedRows.map((row) =>
    columnOrder.map((h) => toCSVString(row[h as keyof typeof row])),
  );
  await client.writeSheet(
    sheetId,
    [columnOrder, ...dataRows],
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
  locationItems: LocationSyncItem[],
): Promise<void> {
  // Items to add/update in sheet
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
        return makeInventoryKey(
          sd.productName ?? "",
          sd.manufacturer,
          sd.locationShortcode,
          sd.locationName,
        );
      }),
  );

  // Keep sheet rows not being deleted/updated
  const keptRows = sheetInventory.filter((row) => {
    const key = makeInventoryKey(
      row.product_name,
      row.manufacturer,
      row.location_shortcode,
      row.location_name,
    );
    return (
      !deleteKeys.has(key) &&
      !updateKeys.has(key) &&
      !sheetKeysToDelete.has(key)
    );
  });

  // Count updates to sheet
  const conflictUpdates = inventoryItems.filter(
    (i) => i.state === "conflict" && i.resolution === "use_app",
  ).length;
  results.inventory.updated += conflictUpdates + movedOrRenamedUseApp.length;

  // Build location_name rename map from location renames pushed to sheet
  // When a location is renamed with "use_app", inventory rows still reference the old name
  const locationRenameMap = new Map<string, string>();
  for (const item of locationItems) {
    if (
      item.state === "renamed" &&
      item.resolution === "use_app" &&
      item.renamedTo &&
      item.renamedFrom
    ) {
      locationRenameMap.set(
        item.renamedTo.toLowerCase().trim(),
        item.renamedFrom,
      );
    }
  }

  // Rebuild sheet rows, cascading location_name updates for renamed locations
  const updatedRows = [
    ...keptRows.map((row) => {
      if (row.location_name && locationRenameMap.size > 0) {
        const newName = locationRenameMap.get(
          row.location_name.toLowerCase().trim(),
        );
        if (newName) {
          return { ...row, location_name: newName };
        }
      }
      return row;
    }),
    ...syncItemsToInventoryCSVRows(inventoryToAddToSheet, true),
  ];

  // Read existing headers to preserve user's column ordering
  const existingHeaders = await client.readHeaderRow(
    sheetId,
    SHEET_NAMES.INVENTORY,
  );

  // Resolve column order (preserves user's ordering, appends new columns)
  const columnOrder = resolveColumnOrder(
    INVENTORY_CSV_HEADERS,
    existingHeaders,
  );

  // Write to sheet using resolved column order
  const dataRows = updatedRows.map((row) =>
    columnOrder.map((h) => toCSVString(row[h as keyof typeof row])),
  );
  await client.writeSheet(
    sheetId,
    [columnOrder, ...dataRows],
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

// Shared helper for syncPreview and applySync
const fetchAndCompareData = async (
  ctx: { db: Database },
  client: ReturnType<typeof getGoogleSheetsClient>,
  sheetId: string,
) => {
  return withTrace(
    TraceNames.api("googleSheets", "fetchAndCompareData"),
    async (span) => {
      span.setAttribute("sheets.sheetId", sheetId);

      // Fetch all data in parallel - DB and Sheets calls are independent
      const [appLocations, appInventory, sheetLocations, inventorySheetData] =
        await Promise.all([
          exportLocationsToCSV(ctx.db),
          exportInventoryToCSV(ctx.db),
          fetchSheetLocations(client, sheetId),
          client.readSheet(sheetId, SHEET_NAMES.INVENTORY),
        ]);

      const sheetInventory = parseSheetRows(inventorySheetData).rows;

      const locationItems = compareLocationsForSync(
        appLocations,
        sheetLocations,
      );
      const inventoryItems = compareInventoryForSync(
        appInventory,
        sheetInventory,
      );

      span.setAttributes({
        "sheets.appLocations": appLocations.length,
        "sheets.appInventory": appInventory.length,
        "sheets.sheetLocations": sheetLocations.length,
        "sheets.sheetInventory": sheetInventory.length,
      });

      return {
        locationItems,
        inventoryItems,
        sheetLocations,
        sheetInventory,
        // Include raw data for snapshot generation
        appLocations,
        appInventory,
      };
    },
  );
};

// Sync preview - unified comparison of app and sheet
const syncPreview = protectedProcedure
  .output(syncPreviewResult)
  .mutation(async ({ ctx }) => {
    return withTrace(
      TraceNames.trpc("mutation", "googleSheets.syncPreview"),
      async (span) => {
        const { client, sheetId } = await getClientAndSheetId(ctx);
        const {
          locationItems,
          inventoryItems,
          appLocations,
          appInventory,
          sheetLocations,
          sheetInventory,
        } = await fetchAndCompareData(ctx, client, sheetId);

        // Generate snapshot hash for race condition prevention
        const snapshotHash = generateSnapshotHash(
          appLocations as unknown as LocationCSVRow[],
          sheetLocations,
          appInventory as unknown as InventoryCSVRow[],
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

        span.setAttributes({
          "sync.locationItems": locationItems.length,
          "sync.inventoryItems": inventoryItems.length,
          "sync.hasUnresolvedConflicts": hasUnresolvedConflicts,
          "sync.hasChangesToApply": hasChangesToApply,
          "sync.validationErrors": validationErrors.length,
        });

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
          snapshotHash,
        };
      },
    );
  });

// Apply sync - execute the sync with user resolutions
const applySync = protectedProcedure
  .input(applySyncInput)
  .output(applySyncResult)
  .mutation(async ({ ctx, input }) => {
    return withTrace(
      TraceNames.trpc("mutation", "googleSheets.applySync"),
      async (span) => {
        const { client, sheetId, appMetadata } = await getClientAndSheetId(ctx);
        const {
          locationItems,
          inventoryItems,
          appLocations,
          appInventory,
          sheetLocations,
          sheetInventory,
        } = await fetchAndCompareData(ctx, client, sheetId);

        // Generate current snapshot hash and compare with preview
        const currentHash = generateSnapshotHash(
          appLocations as unknown as LocationCSVRow[],
          sheetLocations,
          appInventory as unknown as InventoryCSVRow[],
          sheetInventory,
        );

        if (input.snapshotHash !== currentHash) {
          span.setAttribute("sync.snapshotMismatch", true);
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Data changed since preview. Please refresh and review changes before applying sync.",
          });
        }

        span.setAttribute("sync.snapshotValid", true);

        // Apply user resolutions
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
          span.setAttribute("sync.validationFailed", true);
          return {
            ...createEmptySyncResults(),
            success: false,
            errorMessages: validationErrors.map((e) => e.message),
          };
        }

        // Execute sync operations
        const results = createEmptySyncResults();

        // Wrap all DB mutations in single transaction
        try {
          await withTransaction(ctx.db, async (tx) => {
            // Process locations first (inventory may reference them)
            await processImportsToApp(
              {
                db: tx as unknown as Database,
                actorContext: ctx.actorContext,
              },
              locationItems,
              inventoryItems,
              results,
            );

            // Process deletions from app
            await processAppDeletions(
              { db: tx as unknown as Database, actorContext: ctx.actorContext },
              locationItems,
              inventoryItems,
              results,
            );

            // Process renames (app → sheet name)
            await processRenames(
              { db: tx as unknown as Database, actorContext: ctx.actorContext },
              locationItems,
              inventoryItems,
              results,
            );

            // Transaction commits here - either all succeed or all rollback
          });

          span.setAttribute("sync.transactionCommitted", true);
        } catch (error) {
          // Transaction rolled back - database unchanged
          span.setAttributes({
            "sync.transactionFailed": true,
            "sync.error": getErrorMessage(error),
          });

          return {
            ...createEmptySyncResults(),
            success: false,
            errorMessages: [
              `Database transaction failed: ${getErrorMessage(error)}`,
            ],
          };
        }

        // After DB commit, update Google Sheets (if this fails, DB is already committed)
        // Push changes to sheets
        if (input.forceOverwrite) {
          // "Refresh Timestamps" mode: export ALL app data directly (with timestamps)
          // This bypasses sync comparison data and writes fresh exports to the sheet
          const [appLocations, appInventory] = await Promise.all([
            exportLocationsToCSV(ctx.db),
            exportInventoryToCSV(ctx.db),
          ]);

          // Write locations directly
          // Read existing headers to preserve user's column ordering
          const locationExistingHeaders = await client.readHeaderRow(
            sheetId,
            SHEET_NAMES.LOCATIONS,
          );

          // Resolve column order (preserves user's ordering, appends new columns)
          const locationColumnOrder = resolveColumnOrder(
            LOCATION_CSV_HEADERS,
            locationExistingHeaders,
          );

          const locationDataRows = appLocations.map((row) =>
            locationColumnOrder.map((h) =>
              toCSVString(row[h as keyof typeof row]),
            ),
          );
          await client.writeSheet(
            sheetId,
            [locationColumnOrder, ...locationDataRows],
            SHEET_NAMES.LOCATIONS,
          );
          await ensureTableSchema(
            client,
            sheetId,
            SHEET_NAMES.LOCATIONS,
            "locations",
            LOCATION_COLUMN_SCHEMA,
            LOCATION_CSV_HEADERS,
            locationDataRows.length,
          );

          // Write inventory directly (includes timestamps from export)
          // Read existing headers to preserve user's column ordering
          const inventoryExistingHeaders = await client.readHeaderRow(
            sheetId,
            SHEET_NAMES.INVENTORY,
          );

          // Resolve column order (preserves user's ordering, appends new columns)
          const inventoryColumnOrder = resolveColumnOrder(
            INVENTORY_CSV_HEADERS,
            inventoryExistingHeaders,
          );

          const inventoryDataRows = appInventory.map((row) =>
            inventoryColumnOrder.map((h) =>
              toCSVString(row[h as keyof typeof row]),
            ),
          );
          await client.writeSheet(
            sheetId,
            [inventoryColumnOrder, ...inventoryDataRows],
            SHEET_NAMES.INVENTORY,
          );
          await ensureTableSchema(
            client,
            sheetId,
            SHEET_NAMES.INVENTORY,
            "inventory",
            INVENTORY_COLUMN_SCHEMA,
            INVENTORY_CSV_HEADERS,
            inventoryDataRows.length,
          );
        } else {
          // Normal sync mode: push based on sync comparison
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
            locationItems,
          );
        }

        await updateLastSyncTimestamp(ctx, appMetadata);

        span.setAttributes({
          "sync.locationsCreated": results.locations.created,
          "sync.locationsUpdated": results.locations.updated,
          "sync.locationsDeleted": results.locations.deleted,
          "sync.locationsErrors": results.locations.errors,
          "sync.inventoryCreated": results.inventory.created,
          "sync.inventoryUpdated": results.inventory.updated,
          "sync.inventoryDeleted": results.inventory.deleted,
          "sync.inventoryMoved": results.inventory.moved,
          "sync.inventoryErrors": results.inventory.errors,
          "sync.success": results.errorMessages.length === 0,
        });

        return {
          ...results,
          success: results.errorMessages.length === 0,
        };
      },
    );
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
