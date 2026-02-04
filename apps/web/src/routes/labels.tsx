import { useQueries } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Printer } from "lucide-react";
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
import { generateQrDataUrl } from "~/lib/label-generator";
import { parseShortcode } from "~/lib/shortcode";
import { dedupe } from "~/misc/array-helpers";
import type { LocationType } from "~/schemas/location";
import type { ProductCategory } from "~/schemas/product";
import { useTRPC } from "~/trpc/react";

const searchParamsSchema = z.object({
  codes: z.string().optional(),
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

  const locationQueries = useQueries(
    useMemo(() => ({ queries: locationQueryOptions }), [locationQueryOptions]),
  );
  const productQueries = useQueries(
    useMemo(() => ({ queries: productQueryOptions }), [productQueryOptions]),
  );

  const items: LabelItem[] = useMemo(() => {
    const locs = locationQueries
      .map((q) => q.data)
      .filter((d): d is NonNullable<typeof d> => d != null)
      .map((d) => ({
        shortcode: d.shortcode,
        name: d.name,
        entityType: "location" as const,
        locationType: d.type,
      }));
    const prods = productQueries
      .map((q) => q.data)
      .filter((d): d is NonNullable<typeof d> => d != null)
      .map((d) => ({
        shortcode: d.shortcode,
        name: d.name,
        entityType: "product" as const,
        productCategory: d.category,
      }));
    return [...locs, ...prods];
  }, [locationQueries, productQueries]);

  const isLoading =
    locationQueries.some((q) => q.isLoading) ||
    productQueries.some((q) => q.isLoading);

  return { items, isLoading };
}

function LabelsPage() {
  const { codes } = Route.useSearch();
  const router = useRouter();

  const shortcodes = useMemo<string[]>(() => {
    const list =
      codes
        ?.split(",")
        .map((c: string) => c.trim())
        .filter((c: string) => c.length > 0) ?? [];
    return dedupe(list);
  }, [codes]);

  const { items, isLoading } = useShortcodeLookups(shortcodes);

  // Generate QR codes client-side
  const [qrUrls, setQrUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (items.length === 0) return;
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
  }, [items]);

  const allQrReady =
    items.length > 0 && items.every((item) => qrUrls[item.shortcode]);

  const labelItems = useMemo(
    () => items.map((item) => ({ ...item, qrUrl: qrUrls[item.shortcode] })),
    [items, qrUrls],
  );

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
            <Button onClick={() => window.print()} disabled={!allQrReady}>
              <Printer className="mr-2 h-4 w-4" />
              Print
            </Button>
          </div>
        }
      >
        {isLoading ? (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">Loading...</p>
            </CardContent>
          </Card>
        ) : (
          <LabelSheet items={labelItems} />
        )}
      </EntityLayout>
      {/* Portal to body so print CSS can hide everything else */}
      {!isLoading &&
        createPortal(
          <>
            <PrintStyles />
            <LabelSheet items={labelItems} printOnly />
          </>,
          document.body,
        )}
    </>
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

function PrintStyles() {
  return (
    <style
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static print CSS
      dangerouslySetInnerHTML={{
        __html: `
          @media print {
            @page { size: letter; margin: 0.5in; }
            body > *:not(.label-sheet) { display: none; }
            .label-sheet { display: grid !important; }
            .label-sheet > div:nth-child(10n+1) { break-before: page; }
            .label-sheet > div:nth-child(-n+10) { break-before: auto; }
          }
        `,
      }}
    />
  );
}

function LabelSheet({
  items,
  printOnly,
}: {
  items: (LabelItem & { qrUrl?: string })[];
  printOnly?: boolean;
}) {
  return (
    <div
      className={
        printOnly
          ? "label-sheet hidden w-[7.5in] grid-cols-2 gap-0"
          : "mx-auto grid w-[7.5in] grid-cols-2 gap-0 print:hidden"
      }
    >
      {items.map((item) => {
        const color = getLabelColor(item);
        return (
          <div
            key={item.shortcode}
            className="flex h-[2in] w-[3.75in] break-inside-avoid items-center gap-[0.15in] overflow-hidden border border-gray-300 border-dashed py-[0.15in] pr-[0.2in]"
            style={{
              borderLeftWidth: "0.25in",
              borderLeftColor: color,
              borderLeftStyle: "solid",
            }}
          >
            {item.qrUrl ? (
              <img
                src={item.qrUrl}
                alt={`QR ${item.shortcode}`}
                className="h-[0.8in] w-[0.8in] shrink-0"
              />
            ) : (
              <div className="h-[0.8in] w-[0.8in] shrink-0" />
            )}
            <div className="flex min-w-0 flex-col gap-[0.05in]">
              <div className="font-bold font-mono text-[18pt] tracking-[0.5px]">
                {item.shortcode}
              </div>
              <div className="line-clamp-2 text-[#333] text-[11pt]">
                {item.name}
              </div>
              <div
                className="flex items-center gap-1 whitespace-nowrap text-[9pt] capitalize"
                style={{ color }}
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
