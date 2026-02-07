import { unsafeLocationId } from "@cubby/schemas/identifiers";
import type { LocationType } from "@cubby/schemas/location";
import type { ProductCategory } from "@cubby/schemas/product";
import { getShortcodeUrl, parseShortcode } from "@cubby/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  ArrowLeft,
  Download,
  Plus,
  Printer,
  Search,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { z } from "zod";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import {
  getLocationTypeColor,
  typeSupportsQrCode,
} from "~/app/_components/locations/location-type-theme";
import { getCategoryColor } from "~/app/_components/products/category-theme";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import useDebounce from "~/hooks/useDebounce";
import { generateLabelCsv, generateQrDataUrl } from "~/lib/label-generator";
import { dedupe } from "~/misc/array-helpers";
import { useTRPC } from "~/trpc/react";

// test layouts wiht
// ╰─❮ pdftk PLS763-2.625x1.pdf stamp 3x.pdf output overlay.pdf && open overlay.pdf
// ╰─❮ pdftk PLS134-4x1.5.pdf stamp 2x.pdf output overlay.pdf && open overlay.pdf
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
type SheetFormat = keyof typeof SHEET_LAYOUTS;

function isSheetFormat(format: string): format is SheetFormat {
  return format in SHEET_LAYOUTS;
}

const searchParamsSchema = z.object({
  codes: z.string().optional(),
  format: z.enum(["pls134", "pls763", "ptouch"]).optional(),
  skip: z.coerce.number().int().min(0).optional(),
  copies: z.coerce.number().int().min(1).optional(),
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
  parentName?: string | null;
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

  // Batch fetch: one query per entity type instead of N individual queries
  const { data: locationData = [], isLoading: locationsLoading } = useQuery(
    api.location.getByShortcodes.queryOptions({ shortcodes: locationCodes }),
  );

  const { data: productData = [], isLoading: productsLoading } = useQuery(
    api.product.getByShortcodes.queryOptions({ shortcodes: productCodes }),
  );

  const items: LabelItem[] = useMemo(() => {
    const locs = locationData.map((d) => ({
      shortcode: d.shortcode,
      name: d.name,
      entityType: "location" as const,
      locationType: d.type,
      parentName: d.parentName,
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

function AddLabelsPopover({
  codes,
  onCodesChange,
}: {
  codes: string | undefined;
  onCodesChange: (newCodes: string) => void;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus search input when popover opens
  useEffect(() => {
    if (open) {
      // Small delay to let the popover render
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const { data: searchResults, isLoading } = useQuery({
    ...api.location.list.queryOptions({
      filters: { nameFilter: debouncedSearch || undefined },
      pagination: { pageIndex: 0, pageSize: 10 },
      sort: { orderBy: "name", direction: "asc" },
    }),
    enabled: open,
  });

  const locations = searchResults?.items ?? [];

  function mergeCodes(newShortcodes: string[]) {
    const existing =
      codes
        ?.split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0) ?? [];
    const merged = dedupe([...existing, ...newShortcodes]);
    onCodesChange(merged.join(","));
  }

  function handleAddSingle(location: {
    name: string;
    type: LocationType;
    shortcode: string;
  }) {
    if (!typeSupportsQrCode(location.type)) {
      toast.warning(
        `${location.name} is a ${location.type} and doesn't support QR labels`,
      );
      return;
    }
    if (!location.shortcode) {
      toast.warning(`${location.name} has no shortcode`);
      return;
    }
    mergeCodes([location.shortcode]);
    toast.success(`Added ${location.name}`);
  }

  async function handleAddChildren(location: { id: string; name: string }) {
    const full = await queryClient.fetchQuery(
      api.location.getByID.queryOptions({
        id: unsafeLocationId(location.id),
      }),
    );
    const children = full.children ?? [];
    const eligible = children.filter(
      (c) => c.shortcode && typeSupportsQrCode(c.type),
    );

    if (eligible.length === 0) {
      toast.warning(
        `No QR-eligible children found in ${location.name} (rooms/areas are excluded)`,
      );
      return;
    }

    const skipped = children.length - eligible.length;
    mergeCodes(eligible.map((c) => c.shortcode));
    toast.success(
      `Added ${eligible.length} label${eligible.length !== 1 ? "s" : ""} from ${location.name}` +
        (skipped > 0 ? ` (skipped ${skipped} without QR support)` : ""),
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm">
            <Plus className="mr-2 h-4 w-4" />
            Add
          </Button>
        }
      />
      <PopoverContent align="start" className="w-80 p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search locations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {isLoading ? (
            <p className="px-3 py-4 text-center text-muted-foreground text-sm">
              Searching...
            </p>
          ) : locations.length === 0 ? (
            <p className="px-3 py-4 text-center text-muted-foreground text-sm">
              No locations found
            </p>
          ) : (
            locations.map((loc) => (
              <div
                key={loc.id}
                className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
              >
                <LocationIcon
                  type={loc.type}
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">{loc.name}</span>
                <div className="flex shrink-0 gap-1">
                  {typeSupportsQrCode(loc.type) && loc.shortcode && (
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-primary text-xs hover:bg-muted"
                      onClick={() => handleAddSingle(loc)}
                    >
                      Add
                    </button>
                  )}
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-primary text-xs hover:bg-muted"
                    onClick={() => void handleAddChildren(loc)}
                  >
                    <Users className="h-3 w-3" />
                    Children
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LabelsPage() {
  const { codes, format = "pls134", skip = 0, copies = 1 } = Route.useSearch();
  const router = useRouter();
  const navigate = Route.useNavigate();
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  function handleCodesChange(newCodes: string) {
    void navigate({ search: { codes: newCodes, format, skip, copies } });
  }

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

  const visibleLabelItems = useMemo(() => {
    const filtered = labelItems.filter((item) => !hidden.has(item.shortcode));
    if (copies <= 1) return filtered;
    return filtered.flatMap((item) =>
      Array.from({ length: copies }, (_, i) => ({
        ...item,
        copyKey: i === 0 ? item.shortcode : `${item.shortcode}#${i + 1}`,
      })),
    );
  }, [labelItems, hidden, copies]);

  const hiddenItems = useMemo(
    () => labelItems.filter((item) => hidden.has(item.shortcode)),
    [labelItems, hidden],
  );

  const effectiveSkip = isSheetFormat(format) ? skip : 0;

  function toggleHidden(shortcode: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(shortcode)) {
        next.delete(shortcode);
      } else {
        next.add(shortcode);
      }
      return next;
    });
  }

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
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <p className="text-muted-foreground">
              No items selected. Select items from the locations or products
              table, or add them here.
            </p>
            <AddLabelsPopover codes={codes} onCodesChange={handleCodesChange} />
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
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => router.history.back()}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
            <AddLabelsPopover codes={codes} onCodesChange={handleCodesChange} />
            <FormatToggle
              format={format}
              onChange={(f) =>
                navigate({ search: { codes, format: f, skip, copies } })
              }
            />
            {isSheetFormat(format) && (
              <label className="flex items-center gap-1.5 text-sm">
                <span className="text-muted-foreground">Skip</span>
                <input
                  type="number"
                  min={0}
                  max={SHEET_LAYOUTS[format].labelsPerSheet - 1}
                  value={effectiveSkip}
                  onChange={(e) =>
                    navigate({
                      search: {
                        codes,
                        format,
                        copies,
                        skip: Math.max(0, Number(e.target.value) || 0),
                      },
                    })
                  }
                  className="h-8 w-14 rounded-md border border-input bg-background px-2 text-center text-sm"
                />
              </label>
            )}
            <label className="flex items-center gap-1.5 text-sm">
              <span className="text-muted-foreground">Copies</span>
              <input
                type="number"
                min={1}
                max={20}
                value={copies}
                onChange={(e) =>
                  navigate({
                    search: {
                      codes,
                      format,
                      skip,
                      copies: Math.max(1, Number(e.target.value) || 1),
                    },
                  })
                }
                className="h-8 w-14 rounded-md border border-input bg-background px-2 text-center text-sm"
              />
            </label>
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
          <>
            <LabelSummary
              labelCount={visibleLabelItems.length}
              skip={effectiveSkip}
              labelsPerSheet={SHEET_LAYOUTS[format].labelsPerSheet}
            />
            <LabelSheet
              items={visibleLabelItems}
              layout={SHEET_LAYOUTS[format]}
              skip={effectiveSkip}
              onToggle={toggleHidden}
            />
            {hiddenItems.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground text-xs">Hidden:</span>
                {hiddenItems.map((item) => (
                  <button
                    key={item.shortcode}
                    type="button"
                    className="rounded bg-muted px-2 py-0.5 font-mono text-muted-foreground text-xs transition-colors hover:bg-muted/80"
                    onClick={() => toggleHidden(item.shortcode)}
                  >
                    {item.shortcode}
                  </button>
                ))}
              </div>
            )}
          </>
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
              items={visibleLabelItems}
              layout={SHEET_LAYOUTS[format]}
              skip={effectiveSkip}
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

function LabelSummary({
  labelCount,
  skip,
  labelsPerSheet,
}: {
  labelCount: number;
  skip: number;
  labelsPerSheet: number;
}) {
  const totalSlots = labelCount + skip;
  const pages = totalSlots / labelsPerSheet;
  const pagesDisplay = pages % 1 === 0 ? pages.toString() : pages.toFixed(1);
  return (
    <p className="text-muted-foreground text-sm">
      {labelCount} label{labelCount !== 1 && "s"}, {pagesDisplay} page
      {pages !== 1 && "s"}
    </p>
  );
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

function LabelCell({
  item,
  layout,
  interactive,
  preview,
  onToggle,
}: {
  item: LabelItem & { qrUrl?: string };
  layout: (typeof SHEET_LAYOUTS)[SheetFormat];
  interactive: boolean;
  preview: boolean;
  onToggle?: (shortcode: string) => void;
}) {
  const color = getLabelColor(item);
  return (
    <div
      className={[
        "flex break-inside-avoid items-center overflow-hidden",
        interactive && "cursor-pointer transition-opacity hover:opacity-60",
        preview && "rounded-md border border-border/60",
      ]
        .filter(Boolean)
        .join(" ")}
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
      {...(interactive && onToggle
        ? {
            onClick: () => onToggle(item.shortcode),
            role: "button",
            tabIndex: 0,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle(item.shortcode);
              }
            },
          }
        : {})}
    >
      <div className="flex shrink-0 flex-col items-center">
        {item.qrUrl ? (
          <img
            src={item.qrUrl}
            alt={`QR ${item.shortcode}`}
            style={{ height: layout.qrSize, width: layout.qrSize }}
          />
        ) : (
          <div style={{ height: layout.qrSize, width: layout.qrSize }} />
        )}
        <div
          className="font-mono tracking-[0.5px]"
          style={{ fontSize: layout.shortcodeSize }}
        >
          {item.shortcode}
        </div>
      </div>
      <div className="flex min-w-0 flex-col justify-center">
        <div
          className="line-clamp-3 font-bold text-[#333] leading-tight"
          style={{ fontSize: layout.nameSize }}
        >
          {item.name}
        </div>
        {preview && item.parentName && (
          <div
            className="truncate text-muted-foreground"
            style={{ fontSize: layout.shortcodeSize }}
          >
            {item.parentName}
          </div>
        )}
      </div>
    </div>
  );
}

function LabelSheet({
  items,
  layout,
  skip = 0,
  printOnly,
  onToggle,
}: {
  items: (LabelItem & { qrUrl?: string; copyKey?: string })[];
  layout: (typeof SHEET_LAYOUTS)[SheetFormat];
  skip?: number;
  printOnly?: boolean;
  onToggle?: (shortcode: string) => void;
}) {
  const preview = !printOnly;
  const interactive = preview && !!onToggle;
  const n = layout.labelsPerSheet;

  // Build flat list of cell elements: spacers then labels
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < skip; i++) {
    cells.push(
      <div
        key={`spacer-${i}`}
        className={
          preview
            ? "rounded-md border border-border/40 border-dashed"
            : undefined
        }
        style={{ height: layout.labelHeight, width: layout.labelWidth }}
      />,
    );
  }
  for (const item of items) {
    cells.push(
      <LabelCell
        key={item.copyKey ?? item.shortcode}
        item={item}
        layout={layout}
        interactive={interactive}
        preview={preview}
        onToggle={onToggle}
      />,
    );
  }

  // For on-screen, insert page separators between pages
  const gridChildren: React.ReactNode[] = [];
  if (!printOnly && cells.length > n) {
    for (let i = 0; i < cells.length; i++) {
      if (i > 0 && i % n === 0) {
        gridChildren.push(
          <div
            key={`page-sep-${i}`}
            className="col-span-full my-2 border-muted-foreground/30 border-t border-dashed"
          />,
        );
      }
      gridChildren.push(cells[i]);
    }
  } else {
    gridChildren.push(...cells);
  }

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
      {gridChildren}
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
                <td className="px-4 py-2">
                  {item.name}
                  {item.parentName && (
                    <span className="ml-2 text-muted-foreground text-xs">
                      {item.parentName}
                    </span>
                  )}
                </td>
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
