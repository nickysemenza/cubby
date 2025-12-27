import { auth, sheets, type sheets_v4 } from "googleapis/build/src/apis/sheets";

/**
 * Sheet name constants for the Google Sheets workbook
 */
export const SHEET_NAMES = {
  INVENTORY: "Inventory",
  LOCATIONS: "Locations",
} as const;

/**
 * Column type definitions for Google Sheets formatting
 */
export type ColumnType =
  | { kind: "text" }
  | { kind: "number"; decimals?: number }
  | { kind: "currency"; decimals?: number }
  | { kind: "dropdown"; options: string[] }
  | { kind: "checkbox" }
  | { kind: "date" };

export type ColumnSchema = {
  header: string;
  type: ColumnType;
};

// Google Sheets API Table ColumnType enum values
type TableColumnType =
  | "COLUMN_TYPE_UNSPECIFIED"
  | "DOUBLE"
  | "CURRENCY"
  | "PERCENT"
  | "DATE"
  | "TIME"
  | "DATE_TIME"
  | "TEXT"
  | "BOOLEAN"
  | "DROPDOWN"
  | "FILES_CHIP"
  | "PEOPLE_CHIP"
  | "FINANCE_CHIP"
  | "PLACE_CHIP"
  | "RATINGS_CHIP";

// Map our ColumnType to Google Sheets Table ColumnType
const mapToTableColumnType = (col: ColumnType): TableColumnType => {
  switch (col.kind) {
    case "text":
      return "TEXT";
    case "number":
      return "DOUBLE";
    case "currency":
      return "CURRENCY";
    case "dropdown":
      return "DROPDOWN";
    case "checkbox":
      return "BOOLEAN";
    case "date":
      return "DATE";
  }
};

/**
 * Google Sheets client using service account authentication.
 *
 * Setup:
 * 1. Create a Google Cloud project
 * 2. Enable the Google Sheets API
 * 3. Create a service account and download JSON key
 * 4. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY env vars
 * 5. Share your Google Sheet with the service account email as Editor
 */
export class GoogleSheetsClient {
  private sheets: sheets_v4.Sheets | null = null;
  private serviceAccountEmail: string | undefined;

  constructor() {
    this.serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

    if (this.serviceAccountEmail && privateKey) {
      const googleAuth = new auth.GoogleAuth({
        credentials: {
          client_email: this.serviceAccountEmail,
          // Private key may have escaped newlines from env var
          private_key: privateKey.replace(/\\n/g, "\n"),
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

      this.sheets = sheets({ version: "v4", auth: googleAuth });
    }
  }

  /**
   * Check if Google Sheets integration is configured
   */
  isConfigured(): boolean {
    return this.sheets !== null;
  }

  /**
   * Get the service account email for sharing instructions
   */
  getServiceAccountEmail(): string | undefined {
    return this.serviceAccountEmail;
  }

  /**
   * Extract the spreadsheet ID from a Google Sheets URL
   * URL format: https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit...
   */
  static extractSheetId(url: string): string | null {
    const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return match?.[1] ?? null;
  }

  /**
   * Validate that we can access the spreadsheet
   * Returns the spreadsheet title if accessible, null otherwise
   */
  async validateAccess(spreadsheetId: string): Promise<string | null> {
    if (!this.sheets) return null;

    try {
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId,
        fields: "properties.title",
      });
      return response.data.properties?.title ?? null;
    } catch {
      return null;
    }
  }

  /**
   * List all sheet names in the spreadsheet
   */
  async listSheets(spreadsheetId: string): Promise<string[]> {
    if (!this.sheets) {
      throw new Error("Google Sheets client is not configured");
    }

    const response = await this.sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties.title",
    });

    return (
      response.data.sheets?.map((s) => s.properties?.title ?? "") ?? []
    ).filter((name) => name !== "");
  }

  /**
   * Ensure a sheet with the given name exists in the spreadsheet.
   * - If the sheet exists, returns immediately
   * - If looking for "Inventory" and only "Sheet1" exists, renames it
   * - Otherwise creates a new sheet
   */
  async ensureSheetExists(
    spreadsheetId: string,
    sheetName: string,
  ): Promise<void> {
    if (!this.sheets) {
      throw new Error("Google Sheets client is not configured");
    }

    const existingSheets = await this.listSheets(spreadsheetId);
    if (existingSheets.includes(sheetName)) {
      return; // Sheet already exists
    }

    // Migration: if looking for "Inventory" and only "Sheet1" exists, rename it
    if (
      sheetName === SHEET_NAMES.INVENTORY &&
      existingSheets.includes("Sheet1") &&
      !existingSheets.includes(SHEET_NAMES.INVENTORY)
    ) {
      await this.renameSheet(spreadsheetId, "Sheet1", SHEET_NAMES.INVENTORY);
      return;
    }

    // Create the sheet
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetName,
              },
            },
          },
        ],
      },
    });
  }

  /**
   * Rename a sheet
   */
  private async renameSheet(
    spreadsheetId: string,
    oldName: string,
    newName: string,
  ): Promise<void> {
    if (!this.sheets) {
      throw new Error("Google Sheets client is not configured");
    }

    // First get the sheet ID
    const response = await this.sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties",
    });

    const sheet = response.data.sheets?.find(
      (s) => s.properties?.title === oldName,
    );
    if (!sheet?.properties?.sheetId) {
      throw new Error(`Sheet "${oldName}" not found`);
    }

    // Rename the sheet
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: sheet.properties.sheetId,
                title: newName,
              },
              fields: "title",
            },
          },
        ],
      },
    });
  }

  /**
   * Build a range string for a sheet
   * @param sheetName - Optional sheet name (defaults to first sheet)
   * @param cellRange - Cell range like "A:ZZ" or "A1"
   */
  private buildRange(sheetName: string | undefined, cellRange: string): string {
    if (!sheetName) {
      return cellRange;
    }
    // Sheet names with spaces or special chars need quotes
    const quotedName = sheetName.includes(" ") ? `'${sheetName}'` : sheetName;
    return `${quotedName}!${cellRange}`;
  }

  /**
   * Read all rows from a sheet
   * Returns a 2D array of strings (header row + data rows)
   * @param spreadsheetId - The Google Sheet ID
   * @param sheetName - Optional sheet name (defaults to first sheet)
   */
  async readSheet(
    spreadsheetId: string,
    sheetName?: string,
  ): Promise<string[][]> {
    if (!this.sheets) {
      throw new Error("Google Sheets client is not configured");
    }

    const range = this.buildRange(sheetName, "A:ZZ");
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    // Convert all values to strings, handling undefined/null
    return (response.data.values ?? []).map((row) =>
      row.map((cell) => (cell == null ? "" : String(cell))),
    );
  }

  /**
   * Write rows to a sheet (clears existing content first)
   * @param spreadsheetId - The Google Sheet ID
   * @param rows - 2D array of values (including header row)
   * @param sheetName - Optional sheet name (defaults to first sheet)
   */
  async writeSheet(
    spreadsheetId: string,
    rows: string[][],
    sheetName?: string,
  ): Promise<void> {
    if (!this.sheets) {
      throw new Error("Google Sheets client is not configured");
    }

    const clearRange = this.buildRange(sheetName, "A:ZZ");
    const writeRange = this.buildRange(sheetName, "A1");

    // Clear existing content
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: clearRange,
    });

    if (rows.length === 0) return;

    // Write new content
    await this.sheets.spreadsheets.values.update({
      spreadsheetId,
      range: writeRange,
      valueInputOption: "RAW",
      requestBody: {
        values: rows,
      },
    });
  }

  /**
   * Get sheet ID and check if a table exists on the sheet
   */
  private async getSheetInfo(
    spreadsheetId: string,
    sheetName: string,
  ): Promise<{ sheetId: number; tableId: string | null }> {
    if (!this.sheets) {
      throw new Error("Google Sheets client is not configured");
    }

    const response = await this.sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets(properties,tables)",
    });

    const sheet = response.data.sheets?.find(
      (s) => s.properties?.title === sheetName,
    );
    if (!sheet?.properties?.sheetId) {
      throw new Error(`Sheet "${sheetName}" not found`);
    }

    // Check if there's already a table on this sheet
    // The tables array contains Table objects with tableId
    const tables = (sheet as { tables?: Array<{ tableId?: string }> }).tables;
    const tableId = tables?.[0]?.tableId ?? null;

    return { sheetId: sheet.properties.sheetId, tableId };
  }

  /**
   * Create or update a Table on a sheet with proper column types
   * Tables provide column type dropdowns (Number, Text, Currency, etc.)
   *
   * @param spreadsheetId - The Google Sheet ID
   * @param sheetName - Sheet name containing the data
   * @param tableName - Name for the table (must be unique in spreadsheet)
   * @param columns - Column schema definitions
   * @param rowCount - Number of data rows (excluding header)
   */
  async createOrUpdateTable(
    spreadsheetId: string,
    sheetName: string,
    tableName: string,
    columns: ColumnSchema[],
    rowCount: number,
  ): Promise<void> {
    if (!this.sheets) {
      throw new Error("Google Sheets client is not configured");
    }

    const { sheetId, tableId } = await this.getSheetInfo(
      spreadsheetId,
      sheetName,
    );

    // Build column properties for the table
    const columnProperties = columns.map((col, index) => {
      const colType = mapToTableColumnType(col.type);
      const prop: {
        columnIndex: number;
        columnName: string;
        columnType: string;
        dataValidationRule?: {
          condition: {
            type: string;
            values: Array<{ userEnteredValue: string }>;
          };
        };
      } = {
        columnIndex: index,
        columnName: col.header,
        columnType: colType,
      };

      // Dropdown columns require dataValidationRule
      if (col.type.kind === "dropdown") {
        prop.dataValidationRule = {
          condition: {
            type: "ONE_OF_LIST",
            values: col.type.options.map((opt) => ({
              userEnteredValue: opt,
            })),
          },
        };
      }

      return prop;
    });

    const tableRange = {
      sheetId,
      startRowIndex: 0,
      endRowIndex: rowCount + 1, // +1 for header
      startColumnIndex: 0,
      endColumnIndex: columns.length,
    };

    if (tableId) {
      // Update existing table
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateTable: {
                table: {
                  tableId,
                  range: tableRange,
                  columnProperties,
                },
                fields: "range,columnProperties",
              },
            },
          ],
        },
      });
    } else {
      // Create new table
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addTable: {
                table: {
                  name: tableName,
                  range: tableRange,
                  columnProperties,
                },
              },
            },
          ],
        },
      });
    }
  }

  /**
   * Apply column formatting (types, dropdowns, etc.) to a sheet
   * This is the legacy method for non-Table sheets
   * @param spreadsheetId - The Google Sheet ID
   * @param sheetName - Sheet name to format
   * @param columns - Column schema definitions
   * @param rowCount - Number of data rows (excluding header)
   */
  async applyColumnFormatting(
    spreadsheetId: string,
    sheetName: string,
    columns: ColumnSchema[],
    rowCount: number,
  ): Promise<void> {
    if (!this.sheets) {
      throw new Error("Google Sheets client is not configured");
    }

    // Get sheet ID
    const response = await this.sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties",
    });

    const sheet = response.data.sheets?.find(
      (s) => s.properties?.title === sheetName,
    );
    if (!sheet?.properties?.sheetId) {
      throw new Error(`Sheet "${sheetName}" not found`);
    }
    const sheetId = sheet.properties.sheetId;

    const requests: sheets_v4.Schema$Request[] = [];

    // Build formatting requests for each column
    for (let colIndex = 0; colIndex < columns.length; colIndex++) {
      const col = columns[colIndex];
      const range: sheets_v4.Schema$GridRange = {
        sheetId,
        startColumnIndex: colIndex,
        endColumnIndex: colIndex + 1,
        startRowIndex: 1, // Skip header row
        endRowIndex: rowCount + 1,
      };

      switch (col.type.kind) {
        case "number":
          requests.push({
            repeatCell: {
              range,
              cell: {
                userEnteredFormat: {
                  numberFormat: {
                    type: "NUMBER",
                    pattern: col.type.decimals
                      ? `0.${"0".repeat(col.type.decimals)}`
                      : "0",
                  },
                },
              },
              fields: "userEnteredFormat.numberFormat",
            },
          });
          break;

        case "currency":
          requests.push({
            repeatCell: {
              range,
              cell: {
                userEnteredFormat: {
                  numberFormat: {
                    type: "CURRENCY",
                    pattern: `"$"#,##0${col.type.decimals ? `.${"0".repeat(col.type.decimals)}` : ""}`,
                  },
                },
              },
              fields: "userEnteredFormat.numberFormat",
            },
          });
          break;

        case "dropdown":
          requests.push({
            setDataValidation: {
              range,
              rule: {
                condition: {
                  type: "ONE_OF_LIST",
                  values: col.type.options.map((opt) => ({
                    userEnteredValue: opt,
                  })),
                },
                showCustomUi: true,
                strict: false, // Allow other values
              },
            },
          });
          break;

        case "checkbox":
          requests.push({
            setDataValidation: {
              range,
              rule: {
                condition: {
                  type: "BOOLEAN",
                },
                showCustomUi: true,
              },
            },
          });
          break;

        case "date":
          requests.push({
            repeatCell: {
              range,
              cell: {
                userEnteredFormat: {
                  numberFormat: {
                    type: "DATE",
                    pattern: "yyyy-mm-dd",
                  },
                },
              },
              fields: "userEnteredFormat.numberFormat",
            },
          });
          break;

        case "text":
          // Text is the default, but we can explicitly set it
          requests.push({
            repeatCell: {
              range,
              cell: {
                userEnteredFormat: {
                  numberFormat: {
                    type: "TEXT",
                  },
                },
              },
              fields: "userEnteredFormat.numberFormat",
            },
          });
          break;
      }
    }

    if (requests.length > 0) {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      });
    }
  }
}

// Singleton instance
let googleSheetsClient: GoogleSheetsClient | null = null;

export function getGoogleSheetsClient(): GoogleSheetsClient {
  if (!googleSheetsClient) {
    googleSheetsClient = new GoogleSheetsClient();
  }
  return googleSheetsClient;
}
