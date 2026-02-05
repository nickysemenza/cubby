import { useQueries } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Download, Printer } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { z } from "zod";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { getLocationTypeColor } from "~/app/_components/locations/location-type-theme";
import { getCategoryColor } from "~/app/_components/products/category-theme";
import { CategoryIcon } from "~/app/_components/products/product-category-icons";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { generateLabelCsv, generateQrDataUrl } from "~/lib/label-generator";
import { getShortcodeUrl, parseShortcode } from "~/lib/shortcode";
import { dedupe } from "~/misc/array-helpers";
import type { LocationType } from "~/schemas/location";
import type { ProductCategory } from "~/schemas/product";
import { useTRPC } from "~/trpc/react";

const SHEET_LAYOUTS = {
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
    qrSize: "0.8in",
    shortcodeSize: "14pt",
    nameSize: "10pt",
    badgeSize: "8pt",
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
    qrSize: "0.55in",
    shortcodeSize: "10pt",
    nameSize: "7pt",
    badgeSize: "6pt",
    verticalPadding: "0.04in",
    contentGap: "0.06in",
  },
} as const;
type SheetFormat = keyof typeof SHEET_LAYOUTS;

function isSheetFormat(format: string): format is SheetFormat {
  return format in SHEET_LAYOUTS;
}

const searchParamsSchema = z.object({
  codes: z.string().optional(),
  format: z.enum(["pls134", "pls763", "ptouch"]).default("pls134"),
});

export const Route = createFileRoute("/labels")({
  validateSearch: searchParamsSchema.parse,
  component: LabelsPage,
  head: () => ({ meta: [{ title: "Print Labels | cubby" }] }),
});

interface LabelItem {
  shortcode: string;
  name: string;
  entityType: "location" | "product";
  locationType?: LocationType;
  productCategory?: ProductCategory | null;
}

function useShortcodeLookups(shortcodes: string[]) {
  const api = useTRPC();

  // Group shortcodes by entity type
  const { locationCodes, productCodes } = useMemo(() => {
    const locs: string[] = [];
    const prods: string[] = [];
    for (const code of shortcodes) {
      const parsed = parseShortcode(code);
      if (parsed?.type === "location") locs.push(code);
      else if (parsed?.type === "product") prods.push(code);
    }
    return { locationCodes: locs, productCodes: prods };
  }, [shortcodes]);

  // Fetch locations and products in parallel
  const locationQueryOptions = useMemo(
    () =>
      locationCodes.map((shortcode) =>
        api.location.getByShortcode.queryOptions({ shortcode }),
      ),
    [api, locationCodes],
  );
  const productQueryOptions = useMemo(
    () =>
      productCodes.map((shortcode) =>
        api.product.getByShortcode.queryOptions({ shortcode }),
      ),
    [api, productCodes],
  );

  const { data: locationData, isLoading: locationsLoading } = useQueries({
    queries: locationQueryOptions,
    combine: (results) => ({
      data: results
        .map((r) => r.data)
        .filter((d): d is NonNullable<typeof d> => d != null),
      isLoading: results.some((r) => r.isLoading),
    }),
  });

  const { data: productData, isLoading: productsLoading } = useQueries({
    queries: productQueryOptions,
    combine: (results) => ({
      data: results
        .map((r) => r.data)
        .filter((d): d is NonNullable<typeof d> => d != null),
      isLoading: results.some((r) => r.isLoading),
    }),
  });

  const items: LabelItem[] = useMemo(() => {
    const locs = locationData.map((d) => ({
      shortcode: d.shortcode,
      name: d.name,
      entityType: "location" as const,
      locationType: d.type,
    }));
    const prods = productData.map((d) => ({
      shortcode: d.shortcode,
      name: d.name,
      entityType: "product" as const,
      productCategory: d.category,
    }));
    return [...locs, ...prods];
  }, [locationData, productData]);

  const isLoading = locationsLoading || productsLoading;

  return { items, isLoading };
}

function LabelsPage() {
  const { codes, format } = Route.useSearch();
  const router = useRouter();
  const navigate = Route.useNavigate();

  const shortcodes = useMemo<string[]>(() => {
    const list =
      codes
        ?.split(",")
        .map((c: string) => c.trim())
        .filter((c: string) => c.length > 0) ?? [];
    return dedupe(list);
  }, [codes]);

  const { items, isLoading } = useShortcodeLookups(shortcodes);

  // Generate QR codes client-side (needed for sheet formats, not P-Touch)
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

  const labelItems = useMemo(
    () => items.map((item) => ({ ...item, qrUrl: qrUrls[item.shortcode] })),
    [items, qrUrls],
  );

  function handleDownloadCsv() {
    const csv = generateLabelCsv(items);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "labels.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (shortcodes.length === 0) {
    return (
      <EntityLayout title="Print Labels">
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              No items selected. Select items from the locations or products
              table to print labels.
            </p>
          </CardContent>
        </Card>
      </EntityLayout>
    );
  }

  return (
    <>
      <EntityLayout
        title="Print Labels"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => router.history.back()}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
            <FormatToggle
              format={format}
              onChange={(f) => navigate({ search: { codes, format: f } })}
            />
            {format !== "ptouch" ? (
              <Button onClick={() => window.print()} disabled={!allQrReady}>
                <Printer className="mr-2 h-4 w-4" />
                Print
              </Button>
            ) : (
              <Button onClick={handleDownloadCsv} disabled={items.length === 0}>
                <Download className="mr-2 h-4 w-4" />
                Download CSV
              </Button>
            )}
          </div>
        }
      >
        {isLoading ? (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">Loading...</p>
            </CardContent>
          </Card>
        ) : isSheetFormat(format) ? (
          <LabelSheet items={labelItems} layout={SHEET_LAYOUTS[format]} />
        ) : (
          <PtouchPreview items={items} />
        )}
      </EntityLayout>
      {/* Portal to body so print CSS can hide everything else */}
      {isSheetFormat(format) &&
        !isLoading &&
        createPortal(
          <>
            <PrintStyles layout={SHEET_LAYOUTS[format]} />
            <LabelSheet
              items={labelItems}
              layout={SHEET_LAYOUTS[format]}
              printOnly
            />
          </>,
          document.body,
        )}
    </>
  );
}

function FormatToggle({
  format,
  onChange,
}: {
  format: "pls134" | "pls763" | "ptouch";
  onChange: (format: "pls134" | "pls763" | "ptouch") => void;
}) {
  const options = [
    { value: "pls134" as const, label: '4 \u00d7 1.5"' },
    { value: "pls763" as const, label: '2\u215d \u00d7 1"' },
    { value: "ptouch" as const, label: "P-Touch" },
  ];
  return (
    <div className="flex rounded-md border">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`px-3 py-1.5 text-sm transition-colors ${
            format === opt.value
              ? "bg-primary text-primary-foreground"
              : "hover:bg-muted"
          }`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function getLabelColor(item: LabelItem): string {
  if (item.entityType === "location" && item.locationType) {
    return getLocationTypeColor(item.locationType);
  }
  if (item.entityType === "product") {
    return getCategoryColor(item.productCategory ?? null);
  }
  return "hsl(0, 0%, 65%)";
}

function LabelIcon({ item }: { item: LabelItem }) {
  if (item.entityType === "location" && item.locationType) {
    return <LocationIcon type={item.locationType} size={14} />;
  }
  if (item.entityType === "product" && item.productCategory) {
    return <CategoryIcon category={item.productCategory} size={14} />;
  }
  return null;
}

function formatSubtype(item: LabelItem): string {
  if (item.entityType === "location" && item.locationType) {
    return item.locationType.replace("-", " ");
  }
  if (item.entityType === "product" && item.productCategory) {
    return item.productCategory.replace("-", " ");
  }
  return item.entityType;
}

function PrintStyles({
  layout,
}: {
  layout: (typeof SHEET_LAYOUTS)[SheetFormat];
}) {
  const n = layout.labelsPerSheet;
  return (
    <style
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static print CSS
      dangerouslySetInnerHTML={{
        __html: `
          @media print {
            @page { size: letter; margin: ${layout.pageMargin}; }
            body > *:not(.label-sheet) { display: none; }
            .label-sheet { display: grid !important; }
            .label-sheet > div:nth-child(${n}n+1) { break-before: page; }
            .label-sheet > div:nth-child(-n+${n}) { break-before: auto; }
          }
        `,
      }}
    />
  );
}

function LabelSheet({
  items,
  layout,
  printOnly,
}: {
  items: (LabelItem & { qrUrl?: string })[];
  layout: (typeof SHEET_LAYOUTS)[SheetFormat];
  printOnly?: boolean;
}) {
  return (
    <div
      className={
        printOnly
          ? `label-sheet hidden gap-0`
          : "mx-auto grid gap-0 print:hidden"
      }
      style={{
        width: layout.sheetWidth,
        columnGap: layout.columnGap,
        rowGap: 0,
        gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
      }}
    >
      {items.map((item) => {
        const color = getLabelColor(item);
        return (
          <div
            key={item.shortcode}
            className="flex break-inside-avoid items-center overflow-hidden"
            style={{
              height: layout.labelHeight,
              width: layout.labelWidth,
              gap: layout.contentGap,
              paddingTop: layout.verticalPadding,
              paddingBottom: layout.verticalPadding,
              paddingRight: layout.borderWidth,
              borderLeftWidth: layout.borderWidth,
              borderLeftColor: color,
              borderLeftStyle: "solid",
            }}
          >
            {item.qrUrl ? (
              <img
                src={item.qrUrl}
                alt={`QR ${item.shortcode}`}
                style={{ height: layout.qrSize, width: layout.qrSize }}
                className="shrink-0"
              />
            ) : (
              <div
                style={{ height: layout.qrSize, width: layout.qrSize }}
                className="shrink-0"
              />
            )}
            <div className="flex min-w-0 flex-col gap-[0.03in]">
              <div
                className="font-bold font-mono tracking-[0.5px]"
                style={{ fontSize: layout.shortcodeSize }}
              >
                {item.shortcode}
              </div>
              <div
                className="line-clamp-1 text-[#333]"
                style={{ fontSize: layout.nameSize }}
              >
                {item.name}
              </div>
              <div
                className="flex items-center gap-1 whitespace-nowrap capitalize"
                style={{ color, fontSize: layout.badgeSize }}
              >
                <LabelIcon item={item} />
                <span>{formatSubtype(item)}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PtouchPreview({ items }: { items: LabelItem[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="px-4 py-2 text-left font-medium">Shortcode</th>
              <th className="px-4 py-2 text-left font-medium">Name</th>
              <th className="px-4 py-2 text-left font-medium">URL</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.shortcode} className="border-b last:border-b-0">
                <td className="px-4 py-2 font-mono">{item.shortcode}</td>
                <td className="px-4 py-2">{item.name}</td>
                <td className="px-4 py-2 text-muted-foreground">
                  {getShortcodeUrl(item.shortcode)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
