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
