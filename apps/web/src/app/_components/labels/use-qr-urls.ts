import { useEffect, useState } from "react";
import { generateQrDataUrl } from "~/lib/label-generator";
import type { LabelItem } from "./sheet-layouts";

// Generate QR codes client-side (needed for sheet formats, not P-Touch)
export function useQrUrls(items: LabelItem[], format: string) {
  const [qrUrls, setQrUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (items.length === 0 || format === "ptouch") return;
    let cancelled = false;
    Promise.all(
      items.map(async (item) => {
        const url = await generateQrDataUrl(item.shortcode);
        return [item.shortcode, url] as const;
      }),
    ).then((entries) => {
      if (!cancelled) {
        setQrUrls(Object.fromEntries(entries));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [items, format]);

  const allQrReady =
    items.length > 0 && items.every((item) => qrUrls[item.shortcode]);

  return { qrUrls, allQrReady };
}
