import { getLocationTypeColor } from "~/app/_components/locations/location-type-theme";
import { getCategoryColor } from "~/app/_components/products/category-theme";
import type { LabelItem, SHEET_LAYOUTS, SheetFormat } from "./sheet-layouts";

function getLabelColor(item: LabelItem): string {
  if (item.entityType === "location" && item.locationType) {
    return getLocationTypeColor(item.locationType);
  }
  if (item.entityType === "product") {
    return getCategoryColor(item.productCategory ?? null);
  }
  return "hsl(0, 0%, 65%)";
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
          className="line-clamp-3 font-bold text-foreground leading-tight"
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

export function LabelSheet({
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

  const sheet = (
    <div
      className={
        printOnly ? "label-sheet hidden gap-0" : "grid gap-0 md:mx-auto"
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

  if (printOnly) return sheet;

  return (
    <section
      aria-label="Label sheet preview"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the fixed-width paper preview must receive focus so keyboard users can scroll it horizontally
      tabIndex={0}
      className="w-full min-w-0 max-w-full overflow-x-auto print:hidden"
    >
      {sheet}
    </section>
  );
}
