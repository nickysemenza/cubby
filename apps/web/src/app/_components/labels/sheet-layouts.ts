import type { LocationType } from "@cubby/schemas/location";
import type { ProductCategory } from "@cubby/shared";

// test layouts wiht
// ╰─❮ pdftk PLS763-2.625x1.pdf stamp 3x.pdf output overlay.pdf && open overlay.pdf
// ╰─❮ pdftk PLS134-4x1.5.pdf stamp 2x.pdf output overlay.pdf && open overlay.pdf
export const SHEET_LAYOUTS = {
  pls134: {
    // https://www.premiumlabelsupply.com/templates/pls134/
    // https://www.amazon.com/gp/product/B0DV5N4QF5/
    cols: 2,
    labelsPerSheet: 12,
    pageMargin: "1in 0.172in",
    sheetWidth: "8.156in",
    columnGap: "0.156in",
    labelWidth: "4in",
    labelHeight: "1.5in",
    borderWidth: "0.15in",
    qrSize: "1.0in",
    shortcodeSize: "10pt",
    nameSize: "18pt",
    verticalPadding: "0.08in",
    contentGap: "0.12in",
  },
  pls763: {
    // https://www.premiumlabelsupply.com/templates/pls763/
    // https://www.amazon.com/gp/product/B0C27B2DW7
    cols: 3,
    labelsPerSheet: 30,
    pageMargin: "0.5in 0.1875in",
    sheetWidth: "8.125in",
    columnGap: "0.125in",
    labelWidth: "2.625in",
    labelHeight: "1in",
    borderWidth: "0.08in",
    qrSize: "0.62in",
    shortcodeSize: "7pt",
    nameSize: "14pt",
    verticalPadding: "0.04in",
    contentGap: "0.06in",
  },
} as const;
export type SheetFormat = keyof typeof SHEET_LAYOUTS;

export function isSheetFormat(format: string): format is SheetFormat {
  return format in SHEET_LAYOUTS;
}

/**
 * Locations and products only, deliberately. All twelve entities carry a
 * shortcode now, but a QR label is a physical sticker — it belongs on a bin or a
 * thing you own, not on a task or an expense. Don't widen this to the full
 * entity roster just because the codes exist.
 */
export interface LabelItem {
  shortcode: string;
  name: string;
  entityType: "location" | "product";
  locationType?: LocationType;
  productCategory?: ProductCategory | null;
  parentName?: string | null;
}
