import {
  createFileRoute,
  stripSearchParams,
  useRouter,
} from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import { ArrowLeft, Download, Printer } from "lucide-react";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { z } from "zod";
import { AddLabelsPopover } from "~/app/_components/labels/add-labels-popover";
import { FormatToggle } from "~/app/_components/labels/format-toggle";
import { LabelSheet } from "~/app/_components/labels/label-sheet";
import { LabelSummary } from "~/app/_components/labels/label-summary";
import { PrintStyles } from "~/app/_components/labels/print-styles";
import { PtouchPreview } from "~/app/_components/labels/ptouch-preview";
import {
  isSheetFormat,
  SHEET_LAYOUTS,
} from "~/app/_components/labels/sheet-layouts";
import { useQrUrls } from "~/app/_components/labels/use-qr-urls";
import { useShortcodeLookups } from "~/app/_components/labels/use-shortcode-lookups";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { generateLabelCsv } from "~/lib/label-generator";
import { pageTitle } from "~/lib/page-title";
import { urlStringParam } from "~/lib/search-params";

const searchParamsSchema = z.object({
  codes: urlStringParam,
  format: z.enum(["pls134", "pls763", "ptouch"]).optional().catch(undefined),
  skip: z.coerce.number().int().min(0).optional().catch(undefined),
  copies: z.coerce.number().int().min(1).optional().catch(undefined),
});

const searchDefaults = {
  codes: undefined,
  format: undefined,
  skip: undefined,
  copies: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/labels")({
  validateSearch: searchParamsSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: LabelsPage,
  head: () => ({ meta: [{ title: pageTitle("Print labels") }] }),
});

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
    return uniq(list);
  }, [codes]);

  const { items, isLoading } = useShortcodeLookups(shortcodes);

  const { qrUrls, allQrReady } = useQrUrls(items, format);

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
      <Page variant="list" title="Print Labels">
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-6 text-center">
            <p className="text-muted-foreground">
              No items selected. Select items from the locations or products
              table, or add them here.
            </p>
            <AddLabelsPopover codes={codes} onCodesChange={handleCodesChange} />
          </CardContent>
        </Card>
      </Page>
    );
  }

  return (
    <>
      <Page
        variant="list"
        title="Print Labels"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => router.history.back()}>
              <ArrowLeft className="mr-2 size-4" />
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
              <label className="flex items-center gap-1.5 text-sm" /* tight */>
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
                  className="h-7 w-14 rounded-md border border-border bg-input/20 px-2 text-center text-sm"
                />
              </label>
            )}
            <label className="flex items-center gap-1.5 text-sm" /* tight */>
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
                <Printer className="mr-2 size-4" />
                Print
              </Button>
            ) : (
              <Button onClick={handleDownloadCsv} disabled={items.length === 0}>
                <Download className="mr-2 size-4" />
                Download CSV
              </Button>
            )}
          </div>
        }
      >
        {isLoading ? (
          <Card>
            <CardContent className="py-6 text-center">
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
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Description as="span" size="xs">
                  Hidden:
                </Description>
                {hiddenItems.map((item) => (
                  <button
                    key={item.shortcode}
                    type="button"
                    className="rounded bg-muted px-2 py-0.5 font-mono text-muted-foreground text-xs transition-colors hover:bg-muted/80" /* tight */
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
      </Page>
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
