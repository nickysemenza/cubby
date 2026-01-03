/**
 * Label Generator for Entity Shortcodes
 *
 * Generates PNG labels suitable for Brother P-touch printers (1" tape / 24mm).
 * Layout: [QR Code] [Shortcode] [Name]
 */

import QRCode from "qrcode";
import { getShortcodeUrl } from "./shortcode";

/**
 * Label configuration for 1" (24mm) tape
 * Using 180 DPI for print quality
 */
const LABEL_CONFIG = {
  /** Height in pixels at 180 DPI (24mm = ~0.945") */
  height: 170,
  /** Padding around content */
  padding: 10,
  /** Gap between elements */
  gap: 12,
  /** QR code size (square) */
  qrSize: 150,
  /** Font sizes */
  shortcodeFontSize: 36,
  nameFontSize: 24,
  /** Maximum name width before truncation */
  maxNameWidth: 300,
} as const;

interface LabelOptions {
  /** The shortcode (e.g., "L-A3F2" or "P-X7K9") */
  shortcode: string;
  /** Display name for the entity */
  name: string;
  /** Optional custom URL (defaults to getShortcodeUrl) */
  url?: string;
}

/**
 * Generate a label PNG as a Blob
 *
 * Creates a horizontal label with:
 * - QR code on the left (encodes URL)
 * - Shortcode in large font
 * - Name in smaller font (truncated if too long)
 */
export async function generateLabelPng(options: LabelOptions): Promise<Blob> {
  const { shortcode, name, url = getShortcodeUrl(shortcode) } = options;

  // Create canvas
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to create canvas context");
  }

  // Generate QR code as data URL
  const qrDataUrl = await QRCode.toDataURL(url, {
    width: LABEL_CONFIG.qrSize,
    margin: 1,
    errorCorrectionLevel: "M",
  });

  // Load QR code image
  const qrImage = await loadImage(qrDataUrl);

  // Calculate text dimensions
  ctx.font = `bold ${LABEL_CONFIG.shortcodeFontSize}px monospace`;
  const shortcodeMetrics = ctx.measureText(shortcode);

  ctx.font = `${LABEL_CONFIG.nameFontSize}px sans-serif`;
  const truncatedName = truncateText(ctx, name, LABEL_CONFIG.maxNameWidth);
  const nameMetrics = ctx.measureText(truncatedName);

  // Calculate total width
  const textWidth = Math.max(shortcodeMetrics.width, nameMetrics.width);
  const totalWidth =
    LABEL_CONFIG.padding * 2 +
    LABEL_CONFIG.qrSize +
    LABEL_CONFIG.gap +
    textWidth;

  // Set canvas size
  canvas.width = totalWidth;
  canvas.height = LABEL_CONFIG.height;

  // Fill background (white)
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw QR code on the left
  const qrY = (LABEL_CONFIG.height - LABEL_CONFIG.qrSize) / 2;
  ctx.drawImage(
    qrImage,
    LABEL_CONFIG.padding,
    qrY,
    LABEL_CONFIG.qrSize,
    LABEL_CONFIG.qrSize,
  );

  // Draw shortcode (large, bold, monospace)
  ctx.fillStyle = "#000000";
  ctx.font = `bold ${LABEL_CONFIG.shortcodeFontSize}px monospace`;
  ctx.textBaseline = "middle";
  const textX = LABEL_CONFIG.padding + LABEL_CONFIG.qrSize + LABEL_CONFIG.gap;
  const shortcodeY = LABEL_CONFIG.height / 2 - 20;
  ctx.fillText(shortcode, textX, shortcodeY);

  // Draw name (smaller, below shortcode)
  ctx.font = `${LABEL_CONFIG.nameFontSize}px sans-serif`;
  const nameY = LABEL_CONFIG.height / 2 + 25;
  ctx.fillText(truncatedName, textX, nameY);

  // Convert to blob
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Failed to generate label blob"));
        }
      },
      "image/png",
      1.0,
    );
  });
}

/**
 * Download a label as PNG file
 */
export async function downloadLabel(options: LabelOptions): Promise<void> {
  const blob = await generateLabelPng(options);
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `label-${options.shortcode}.png`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}

/**
 * Load an image from a data URL
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Truncate text to fit within maxWidth, adding ellipsis if needed
 */
function truncateText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  const metrics = ctx.measureText(text);
  if (metrics.width <= maxWidth) {
    return text;
  }

  const ellipsis = "...";
  let truncated = text;
  while (truncated.length > 0) {
    truncated = truncated.slice(0, -1);
    const testText = truncated + ellipsis;
    if (ctx.measureText(testText).width <= maxWidth) {
      return testText;
    }
  }
  return ellipsis;
}
