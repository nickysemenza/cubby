import QRCode from "qrcode";
import { getShortcodeUrl } from "./shortcode";

/**
 * Generate a QR code data URL for a shortcode.
 */
export async function generateQrDataUrl(shortcode: string): Promise<string> {
  return QRCode.toDataURL(getShortcodeUrl(shortcode), {
    width: 200,
    margin: 1,
    errorCorrectionLevel: "M",
  });
}

/**
 * Generate a CSV string for P-Touch label printing.
 * Columns: shortcode, name, url
 */
export function generateLabelCsv(
  items: { shortcode: string; name: string }[],
): string {
  const header = "shortcode,name,url";
  const rows = items.map((item) => {
    const name = item.name.includes(",")
      ? `"${item.name.replace(/"/g, '""')}"`
      : item.name;
    return `${item.shortcode},${name},${getShortcodeUrl(item.shortcode)}`;
  });
  return [header, ...rows].join("\n");
}
