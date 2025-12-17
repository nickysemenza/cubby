import { google } from "googleapis";
import type { sheets_v4 } from "googleapis";

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
      const auth = new google.auth.GoogleAuth({
        credentials: {
          client_email: this.serviceAccountEmail,
          // Private key may have escaped newlines from env var
          private_key: privateKey.replace(/\\n/g, "\n"),
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

      this.sheets = google.sheets({ version: "v4", auth });
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
   * Read all rows from the first sheet
   * Returns a 2D array of strings (header row + data rows)
   */
  async readSheet(spreadsheetId: string): Promise<string[][]> {
    if (!this.sheets) {
      throw new Error("Google Sheets client is not configured");
    }

    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "A:ZZ", // Read all columns
    });

    // Convert all values to strings, handling undefined/null
    return (response.data.values ?? []).map((row) =>
      row.map((cell) => (cell == null ? "" : String(cell))),
    );
  }

  /**
   * Write rows to the first sheet (clears existing content first)
   * @param spreadsheetId - The Google Sheet ID
   * @param rows - 2D array of values (including header row)
   */
  async writeSheet(spreadsheetId: string, rows: string[][]): Promise<void> {
    if (!this.sheets) {
      throw new Error("Google Sheets client is not configured");
    }

    // Clear existing content
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: "A:ZZ",
    });

    if (rows.length === 0) return;

    // Write new content
    await this.sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "A1",
      valueInputOption: "RAW",
      requestBody: {
        values: rows,
      },
    });
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
