import { manualUnitMapping } from "@cubby/schemas/unitmapping";
import { locationTypeValues, productCategoryValues } from "@cubby/shared";
import { buildNutrients } from "@cubby/usda-schemas";
import {
  Bell,
  ChevronsUpDown,
  FileText,
  Inbox,
  Layers,
  Package,
  Wrench,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import {
  type CookbookPreview,
  type ExpensePreview,
  type IngredientPreview,
  type InventoryPreview,
  type LocationPreview,
  type MealPreview,
  type ProductPreview,
  type ProjectPreview,
  type PurchasePreview,
  type RecipePreview,
  type TaskPreview,
  toCookbookCard,
  toExpenseCard,
  toIngredientCard,
  toInventoryCard,
  toLocationCard,
  toMealCard,
  toProductCard,
  toProjectCard,
  toPurchaseCard,
  toRecipeCard,
  toTaskCard,
  toUsdaCard,
  toVendorCard,
  type UsdaPreview,
  type VendorPreview,
} from "~/app/_components/EntityPreviewContent";
import { HoverableTimestamp } from "~/app/_components/HoverableTimestamp";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";
import { LocationTypeLabel } from "~/app/_components/locations/LocationTypeLabel";
import { ManifestCard } from "~/app/_components/preview/manifest-card";
import { CategoryLabel } from "~/app/_components/products/CategoryLabel";
import {
  DistributionGlyph,
  StripPlotCell,
} from "~/app/_components/recipe/compare/DeviationBar";
import { DecompositionView } from "~/app/_components/recipe/decomposition-view";
import { RecipeTag } from "~/app/_components/recipe/recipe-tag";
import { ImageStatusBadge } from "~/app/_components/table/StatusBadge";
import { UnitMappingGraph } from "~/app/_components/units/unit-mapping-graph";
import { UnitMappingPairField } from "~/app/_components/units/unit-mapping-pair-field";
import { ColoredAlert } from "~/components/common/colored-alert";
import { InfoRow } from "~/components/common/info-row";
import { DashboardCard } from "~/components/layout/dashboard-card";
import { PageHero } from "~/components/layouts/page-hero";
import { AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { FilterableCombobox } from "~/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { DotLabel } from "~/components/ui/dot-label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { InkStamp } from "~/components/ui/ink-stamp";
import { Input } from "~/components/ui/input";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { Label } from "~/components/ui/label";
import { NoneValue } from "~/components/ui/none-value";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { QuantityInput } from "~/components/ui/quantity-input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { StatGrid, StatTile } from "~/components/ui/stat-tile";
import { Surface } from "~/components/ui/surface";
import { Switch } from "~/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { TicketDivider } from "~/components/ui/ticket-divider";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  Caption,
  DenseMeta,
  MonoValue,
  TableLabel,
} from "~/components/ui/typography";
import { ViewSwitcher } from "~/components/ui/view-switcher";
import { INGREDIENT_PART_COLOR } from "~/lib/ingredient-part-colors";
import { cn } from "~/lib/utils";

/** Surface + semantic palette tokens, grouped for the swatch grid. */
const SURFACE_TOKENS = [
  "--background",
  "--card",
  "--muted",
  "--accent",
  "--secondary",
  "--border",
  "--input",
];
const SEMANTIC_TOKENS = [
  "--primary",
  "--destructive",
  "--positive",
  "--plum",
  "--slate",
];
const CHART_TOKENS = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
  "--chart-7",
  "--chart-8",
];
const CHART_SEQ_TOKENS = [
  "--chart-seq-1",
  "--chart-seq-2",
  "--chart-seq-3",
  "--chart-seq-4",
  "--chart-seq-5",
];

// The core palette for the design-language prose, rendered live from the tokens
// (the swatch reads `var(token)` — colors are never hardcoded here).
const DESIGN_PALETTE: { token: string; name: string; role: string }[] = [
  { token: "--brand-paper", name: "paper", role: "base canvas" },
  { token: "--brand-paper-alt", name: "paper-alt", role: "zebra / inset" },
  { token: "--brand-cream", name: "paper-surface", role: "headers / panels" },
  { token: "--brand-foreground", name: "ink", role: "text + thick rules" },
  { token: "--brand-hairline", name: "hairline", role: "dividers / borders" },
  {
    token: "--brand-ultramarine",
    name: "ultramarine",
    role: "the lone accent",
  },
];

// Spans every node kind so the conversion-graph theming (volume/weight/money/
// nutrient/calories/other) is all visible on one canvas. Module-level keeps the
// reference stable for the memoized graph.
const GRAPH_FIXTURE = [
  manualUnitMapping(
    { value: 1, unit: "cup" },
    { value: 120, unit: "g" },
    "fixture",
  ),
  manualUnitMapping(
    { value: 2, unit: "lb" },
    { value: 5, unit: "dollar" },
    "fixture",
  ),
  manualUnitMapping(
    { value: 100, unit: "g" },
    { value: 281, unit: "mg potassium" },
    "fixture",
  ),
  manualUnitMapping(
    { value: 100, unit: "g" },
    { value: 387, unit: "kcal" },
    "fixture",
  ),
  manualUnitMapping(
    { value: 1, unit: "cup packed" },
    { value: 1, unit: "cup" },
    "fixture",
  ),
];

const SCROLL_ROWS = Array.from(
  { length: 20 },
  (_, i) => `Scrollable row ${i + 1}`,
);

function Swatch({ token }: { token: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="h-12 w-full rounded-none border border-border"
        style={{ backgroundColor: `var(${token})` }}
      />
      <span className="font-mono text-3xs text-muted-foreground">
        {token.replace(/^--/, "")}
      </span>
    </div>
  );
}

/** One labeled section of the gallery — mono eyebrow + import hint + body. */
function GallerySection({
  title,
  source,
  children,
}: {
  title: string;
  source?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-2 border-[var(--border)] border-b pb-1">
        <h2 className="border-0 p-0 font-mono text-slate text-sm uppercase tracking-wider">
          {title}
        </h2>
        {source && (
          <span className="font-mono text-3xs text-muted-foreground/70">
            {source}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

/** A small framed row for grouping example instances with a caption. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-28 shrink-0 font-mono text-3xs text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** Fraction-aware quantity field beside its underlying f64, for the gallery. */
function QtyDemo({ initial }: { initial: number | null }) {
  const [value, setValue] = useState<number | null>(initial);
  return (
    <div className="flex items-center gap-2">
      <div className="w-20">
        <QuantityInput
          value={value}
          onChange={setValue}
          aria-label="Quantity demo"
          placeholder="qty"
        />
      </div>
      <span className="font-mono text-3xs text-muted-foreground">
        = {value ?? "null"}
      </span>
    </div>
  );
}

/** AmountFieldGroup + UnitMappingPairField on a throwaway form, for the gallery. */
function FormGroupsDemo() {
  const form = useForm({
    defaultValues: {
      amount: { value: 1.5 as number | null, unit: "cup" },
      mapping: {
        a: { value: 1 as number | null, unit: "cup" },
        b: { value: 240 as number | null, unit: "g" },
        source: null as string | null,
      },
    },
  });
  return (
    <div className="space-y-4">
      <Row label="Amount">
        <div className="max-w-[16rem]">
          <AmountFieldGroup
            form={form}
            valuePath="amount.value"
            unitPath="amount.unit"
          />
        </div>
      </Row>
      <Row label="Mapping pair">
        <div className="flex flex-wrap items-end gap-2">
          <UnitMappingPairField form={form} path="mapping" showSource />
        </div>
      </Row>
    </div>
  );
}

/** ViewSwitcher (toggle-group) with local state, for the gallery. */
function ViewSwitcherDemo() {
  const [view, setView] = useState("table");
  return (
    <ViewSwitcher
      value={view}
      onValueChange={setView}
      options={[
        { value: "table", label: "Table" },
        { value: "gallery", label: "Gallery" },
        { value: "charts", label: "Charts" },
      ]}
    />
  );
}

export function DesignGallery() {
  const [comboValue, setComboValue] = useState<string | null>("food");
  const [switchOn, setSwitchOn] = useState(true);
  const [checked, setChecked] = useState(true);

  return (
    <div className="container mx-auto max-w-5xl space-y-10 py-6">
      <div className="space-y-1">
        <PageHero variant="list" title="Design" />
        <p className="text-muted-foreground text-sm">
          Living gallery of cubby's components and tokens. Not in the nav —
          reachable at /design.
        </p>
      </div>

      <GallerySection title="Design language" source="Warm-Paper Ledger">
        <div className="space-y-4 text-sm">
          <p className="text-foreground">
            A print-editorial aesthetic applied to a data-dense dashboard. Cubby
            is still a dashboard — panels, metrics, charts, tables — but it
            reads like a printed control sheet or ledger, not a lit-up glass UI.{" "}
            <span className="font-medium">
              Matte instrument panel, not glass dashboard:
            </span>{" "}
            no glass, glow, drop shadows, dark canvas, neon, or gradient fills.
            Light mode only.
          </p>
          <p className="border-foreground border-l-[3px] bg-muted/40 px-3 py-2 text-foreground">
            <span className="font-medium">The one rule —</span> separation by
            rule and tone, never by elevation. The moment something casts a
            shadow or glows it reads as glass. Keep everything flat on the paper
            and it stays a ledger.
          </p>

          <div>
            <p className="eyebrow mb-2">Palette</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              {DESIGN_PALETTE.map(({ token, name, role }) => (
                <div key={name} className="flex items-center gap-2">
                  <span
                    className="size-7 shrink-0 border border-border"
                    style={{ backgroundColor: `var(${token})` }}
                  />
                  <span className="min-w-0">
                    <span className="block font-mono text-2xs text-foreground">
                      {name}
                    </span>
                    <span className="block text-2xs text-muted-foreground">
                      {role}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <p className="eyebrow">Type</p>
            <ul className="space-y-1 text-muted-foreground">
              <li>
                <span className="font-mono text-foreground">
                  JetBrains Mono
                </span>{" "}
                — data, cells, metrics, numerals (tabular-nums, right-aligned).
              </li>
              <li>
                <span className="font-heading text-foreground">
                  Space Grotesk
                </span>{" "}
                — headings &amp; panel titles, letter-spacing -0.02em.
              </li>
              <li>
                <span className="text-foreground">Inter</span> — body &amp;
                prose. Eyebrows are mono, uppercase, tracked-out.
              </li>
            </ul>
          </div>

          <div className="space-y-1">
            <p className="eyebrow">How dashboard elements translate</p>
            <ul className="space-y-1 text-muted-foreground">
              <li>
                · Panels → ruled regions: a hairline border or a 3px ink
                top-rule, paper-surface background, square corners, zero shadow.
              </li>
              <li>
                · Stat tiles → ledger entries: a big mono number + small label,
                hairline-divided. Accent only on the one live metric.
              </li>
              <li>
                · Charts → matte &amp; ruled: a flat ink ladder + a single
                ultramarine, hairline gridlines, no gradients or glow. Rating
                scales stay off the blue axis.
              </li>
              <li>
                · Tables → zebra by paper tone; category fills are tints, not
                chips; sticky paper-surface headers under a 3px ink rule; tight
                rows.
              </li>
              <li>
                · Nav &amp; chrome → hairline-divided and flat. No raised or
                shadowed bars.
              </li>
              <li>
                · Accent is the loudest thing on screen — active row, hover,
                focus, the one live value. Everywhere else stays ink + paper.
              </li>
            </ul>
          </div>

          <p className="border-border border-l-2 pl-3 text-muted-foreground italic">
            A warm-paper instrument panel: dense mono data on soft paper, panels
            defined by ink rules and hairlines instead of shadows, matte flat
            charts, and a lone ultramarine accent reserved for the live/active
            value — a dashboard that reads like a printed ledger, not a glass
            one.
          </p>

          <p className="text-2xs text-muted-foreground">
            <span className="eyebrow">References</span> McMaster-Carr ·
            Datasette · The Monospace Web · Oxide Computer (light) · US /
            Berkeley Graphics · Gwern + Tufte CSS. Not the vibe: Fey, Mercury,
            glass / dark dashboards — same density, opposite material. Paper,
            not glass.
          </p>
        </div>
      </GallerySection>

      <GallerySection title="Color tokens" source="styles.css :root">
        <div className="space-y-4">
          <div>
            <p className="mb-2 font-mono text-3xs text-muted-foreground uppercase tracking-wider">
              Surfaces
            </p>
            <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
              {SURFACE_TOKENS.map((t) => (
                <Swatch key={t} token={t} />
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 font-mono text-3xs text-muted-foreground uppercase tracking-wider">
              Semantic
            </p>
            <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
              {SEMANTIC_TOKENS.map((t) => (
                <Swatch key={t} token={t} />
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 font-mono text-3xs text-muted-foreground uppercase tracking-wider">
              Chart ramp
            </p>
            <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
              {CHART_TOKENS.map((t) => (
                <Swatch key={t} token={t} />
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 font-mono text-3xs text-muted-foreground uppercase tracking-wider">
              Sequential ramp
            </p>
            <div className="grid grid-cols-5 gap-3 sm:grid-cols-8">
              {CHART_SEQ_TOKENS.map((t) => (
                <Swatch key={t} token={t} />
              ))}
            </div>
          </div>
        </div>
      </GallerySection>

      <GallerySection
        title="Rule & tone separation"
        source="Warm-Paper Ledger — no elevation"
      >
        <p className="mb-3 font-mono text-3xs text-muted-foreground uppercase tracking-wider">
          Panels are defined by a 3px ink top-rule + hairline border and zebra
          paper tone — never a shadow, glow, or gradient. Corners are square.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Ruled ledger panel: ink top-rule + hairline frame + zebra rows */}
          <div className="border border-[var(--border)] border-t-[3px] border-t-foreground bg-card">
            <div className="flex items-baseline justify-between px-3 py-2">
              <span className="eyebrow">Ledger panel</span>
              <span className="font-mono text-3xs text-muted-foreground">
                rule + hairline
              </span>
            </div>
            <div className="border-border border-t font-mono text-xs tabular-nums">
              {[
                ["rolled oats", "$9.41"],
                ["almond milk", "$5.42"],
                ["kosher salt", "$11.00"],
                ["bread flour", "$4.20"],
              ].map(([name, price], i) => (
                <div
                  key={name}
                  className={cn(
                    "flex items-center justify-between px-3 py-1.5",
                    // Zebra by tone — alternating paper / paper-alt, no border
                    i % 2 === 1 && "bg-muted",
                  )}
                >
                  <span>{name}</span>
                  <span>{price}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Separation primitives: the three load-bearing rules/tones */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="h-8 w-12 shrink-0 border-t-[3px] border-t-foreground bg-card" />
              <span className="font-mono text-3xs text-muted-foreground">
                3px ink top-rule (var(--rule-ink)) — panel / header edge
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="h-8 w-12 shrink-0 border border-[var(--border)] bg-card" />
              <span className="font-mono text-3xs text-muted-foreground">
                hairline border (var(--border)) — quiet division
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-12 shrink-0 flex-col border border-[var(--border)]">
                <div className="flex-1 bg-card" />
                <div className="flex-1 bg-muted" />
              </div>
              <span className="font-mono text-3xs text-muted-foreground">
                zebra tone (bg-card / bg-muted) — row banding, no rule
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="h-8 w-12 shrink-0 border border-[var(--border)] border-l-4 border-l-primary bg-card" />
              <span className="font-mono text-3xs text-muted-foreground">
                ultramarine spine (border-l-primary) — the one live accent
              </span>
            </div>
          </div>
        </div>
      </GallerySection>

      <GallerySection title="Typography" source="styles.css @layer base">
        <div className="space-y-2">
          <h1>Heading 1 — Space Grotesk</h1>
          <h2 className="border-0 p-0">Heading 2 — Space Grotesk</h2>
          <h3 className="font-heading font-semibold text-lg">
            Heading 3 — Space Grotesk
          </h3>
          <p className="text-sm">
            Body copy is Inter. The quick brown fox jumps over the lazy dog —
            crisp, neutral, legible at small sizes.
          </p>
          <p className="font-mono text-xs">
            Mono is JetBrains Mono — used on chrome, codes, and numerals:
            041570052600 · $9.41 · 248
          </p>
          <p className="eyebrow">Eyebrow micro-label</p>
          <div className="flex items-baseline gap-4 text-muted-foreground">
            <span className="text-3xs">text-3xs</span>
            <span className="text-2xs">text-2xs</span>
            <span className="text-xs">text-xs</span>
            <span className="text-sm">text-sm</span>
            <span className="text-base">text-base</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-[var(--border)] border-t pt-2">
            <Row label="TableLabel">
              <TableLabel>Unit price</TableLabel>
            </Row>
            <Row label="MonoValue">
              <MonoValue>$9.41</MonoValue>
              <MonoValue tone="muted">248</MonoValue>
              <MonoValue tone="strong">041570052600</MonoValue>
            </Row>
            <Row label="Caption">
              <Caption>A figure caption.</Caption>
            </Row>
            <Row label="DenseMeta">
              <DenseMeta>updated 2h ago · 12 items</DenseMeta>
            </Row>
          </div>
        </div>
      </GallerySection>

      <GallerySection title="Surfaces" source="components/ui/surface">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {(["specPlate"] as const).map((variant) => (
            <Surface key={variant} variant={variant} className="p-3">
              <TableLabel>{variant}</TableLabel>
            </Surface>
          ))}
        </div>
      </GallerySection>

      <GallerySection
        title="Ingredient decomposition"
        source="components/recipe/decomposition-view"
      >
        <div className="space-y-3">
          <Row label="3 parts">
            <DecompositionView rawLine="1 ¼ cups all-purpose flour, sifted" />
          </Row>
          <Row label="Ranged + paren">
            <DecompositionView rawLine="2–3 cups (240–360 g) bread flour" />
          </Row>
          <Row label="Amount + name">
            <DecompositionView rawLine="2 cloves garlic" />
          </Row>
          <Row label="Whole = name">
            {/* The grammar reads the whole line as the name — the digit stays put
                (no phantom-quantity warning). One name span, no amount. */}
            <DecompositionView rawLine="Pierre Ferrand 1840 Cognac" />
          </Row>
          <Row label="Recognizer">
            {/* A whole-line recognizer produced the result → no field spans, so
                the line renders plain. The carve has nothing to show here. */}
            <DecompositionView rawLine="Juice of 1 lemon" />
          </Row>
          <Row label="Legend">
            <span className="flex flex-wrap items-center gap-3 text-2xs text-muted-foreground">
              {Object.entries(INGREDIENT_PART_COLOR).map(([part, color]) => (
                <span key={part} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-0 w-3.5 border-b-2"
                    style={{ borderBottomColor: color }}
                  />
                  {part}
                </span>
              ))}
            </span>
          </Row>
        </div>
      </GallerySection>

      <GallerySection
        title="Comparison glyphs"
        source="components/recipe/compare/DeviationBar"
      >
        <div className="space-y-3">
          <Row label="Strip · μ75 of 100">
            {[
              { v: 0, isMax: true },
              { v: 60, isMax: false },
              { v: 75, isMax: false },
              { v: 90, isMax: false },
              { v: 100, isMax: false },
            ].map((d) => (
              <div key={d.v} className="w-32">
                <span
                  className={`font-mono text-sm tabular-nums ${d.isMax ? "font-medium" : ""}`}
                  style={d.isMax ? { color: "var(--primary)" } : undefined}
                >
                  {d.v}%
                </span>
                <StripPlotCell
                  value={d.v}
                  mean={75}
                  max={100}
                  isMax={d.isMax}
                />
              </div>
            ))}
          </Row>
          <Row label="Tight cluster">
            {[80, 89, 59, 87].map((v) => (
              <div key={v} className="w-32">
                <span
                  className={`font-mono text-sm tabular-nums ${v === 59 ? "font-medium" : ""}`}
                  style={v === 59 ? { color: "var(--primary)" } : undefined}
                >
                  {v}%
                </span>
                <StripPlotCell value={v} mean={79} max={89} isMax={v === 59} />
              </div>
            ))}
          </Row>
          <Row label="Distribution">
            <div className="w-40">
              <span className="font-medium font-mono text-sm tabular-nums">
                75%
              </span>
              <DistributionGlyph mean={75} min={0} max={100} std={43} />
            </div>
            <div className="w-40">
              <span className="font-medium font-mono text-sm tabular-nums">
                79%
              </span>
              <DistributionGlyph mean={79} min={59} max={89} std={12} />
            </div>
          </Row>
          <Row label="Legend">
            <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: "var(--primary)" }}
              />
              largest deviation from average
            </span>
          </Row>
        </div>
      </GallerySection>

      <GallerySection title="Buttons" source="components/ui/button">
        <div className="space-y-3">
          <Row label="Variants">
            <Button>Default</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="link">Link</Button>
          </Row>
          <Row label="Sizes">
            <Button size="xs">xs</Button>
            <Button size="sm">sm</Button>
            <Button size="default">default</Button>
          </Row>
          <Row label="Icon">
            <Button size="icon-sm" aria-label="bell">
              <Bell />
            </Button>
            <Button size="icon" aria-label="bell">
              <Bell />
            </Button>
            <Button variant="outline" size="icon" aria-label="bell">
              <Bell />
            </Button>
          </Row>
          <Row label="States">
            <Button disabled>Disabled</Button>
            <Button variant="outline" disabled>
              Disabled
            </Button>
          </Row>
        </div>
      </GallerySection>

      <GallerySection
        title="Badges & labels"
        source="badge · DotLabel · EntityInlineLink"
      >
        <div className="space-y-3">
          <Row label="Badge">
            <Badge>default</Badge>
            <Badge variant="secondary">secondary</Badge>
            <Badge variant="outline">outline</Badge>
            <Badge variant="destructive">destructive</Badge>
          </Row>
          <Row label="Categories">
            {productCategoryValues.map((c) => (
              <CategoryLabel key={c} category={c} />
            ))}
          </Row>
          <Row label="Location types">
            {locationTypeValues.slice(0, 7).map((t) => (
              <LocationTypeLabel key={t} type={t} />
            ))}
          </Row>
          <Row label="Entity links">
            <EntityInlineLink
              entity="ingredient"
              data={{ id: "1", shortcode: "ING-0001", name: "almond butter" }}
            />
            <EntityInlineLink
              entity="product"
              data={{
                id: "1",
                shortcode: "PRD-0001",
                name: "Cyclone 200ES",
                manufacturer: "Everlast",
              }}
            />
            <EntityInlineLink
              entity="recipe"
              data={{ id: "1", shortcode: "RCP-0001", name: "Za'atar" }}
            />
            <EntityInlineLink
              entity="location"
              data={{
                id: "1",
                shortcode: "LOC-0001",
                name: "Chrome Wire Shelf",
                type: "shelf",
              }}
            />
            <EntityInlineLink
              entity="usda-food"
              data={{
                foodInfo: { description: "Almonds, raw" },
                fdc_id: 12345,
              }}
            />
          </Row>
          <Row label="Recipe tags">
            <RecipeTag tag="diet:vegan" />
            <RecipeTag tag="cuisine:thai" />
            <RecipeTag tag="weeknight" />
          </Row>
          <Row label="Status">
            <ImageStatusBadge status="UPLOADED" />
            <ImageStatusBadge status="PENDING" />
            <ImageStatusBadge status="FAILED" />
          </Row>
          <Row label="Ink stamp">
            <InkStamp tone="ink">On file</InkStamp>
            <InkStamp tone="green">In stock</InkStamp>
            <InkStamp tone="red">Unsaved</InkStamp>
          </Row>
        </div>
      </GallerySection>

      <GallerySection
        title="Forms"
        source="input · textarea · switch · checkbox · combobox"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Text input</Label>
            <Input placeholder="e.g. rolled oats" />
          </div>
          <div className="space-y-1.5">
            <Label>Combobox</Label>
            <FilterableCombobox
              items={productCategoryValues.map((c) => ({ value: c, label: c }))}
              value={comboValue}
              onValueChange={setComboValue}
              placeholder="Pick a category"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Textarea</Label>
            <Textarea placeholder="Notes…" rows={2} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Quantity (fraction-aware)</Label>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <QtyDemo initial={1 / 3} />
              <QtyDemo initial={1.5} />
              <QtyDemo initial={1 / 16} />
              <QtyDemo initial={0.37} />
              <QtyDemo initial={34} />
            </div>
            <p className="font-mono text-3xs text-muted-foreground">
              Stored f64 shown after =. Renders fractions, parses 1/3 · ⅓ · 1
              1/2 · decimals on blur.
            </p>
          </div>
          <Row label="Switch">
            <Switch checked={switchOn} onCheckedChange={setSwitchOn} />
            <span className="text-muted-foreground text-xs">
              {switchOn ? "On" : "Off"}
            </span>
          </Row>
          <Row label="Checkbox">
            <Checkbox
              checked={checked}
              onCheckedChange={(v) => setChecked(!!v)}
            />
            <span className="text-muted-foreground text-xs">
              {checked ? "Checked" : "Unchecked"}
            </span>
          </Row>
        </div>
      </GallerySection>

      <GallerySection title="Cards" source="components/ui/card">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="p-4">
            <CardHeader className="px-0">
              <CardTitle icon={Package}>Card</CardTitle>
            </CardHeader>
            <CardContent className="px-0 text-sm">
              One ruled region — paper-surface fill + hairline border, square
              corners, zero shadow. Eyebrow title takes an optional{" "}
              <code>icon</code>.
            </CardContent>
          </Card>
          <DashboardCard icon={Layers} title="Dashboard card">
            <p className="text-sm">
              Same surface + an icon-eyebrow header helper.
            </p>
          </DashboardCard>
        </div>
      </GallerySection>

      <GallerySection title="Table" source="components/ui/table">
        <div className="overflow-hidden rounded-none border border-[var(--border)]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ingredient</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">almond milk</TableCell>
                <TableCell>
                  <CategoryLabel category="food" />
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  $5.42
                </TableCell>
              </TableRow>
              <TableRow data-state="selected">
                <TableCell className="font-medium">rolled oats</TableCell>
                <TableCell>
                  <CategoryLabel category="food" />
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  $9.41
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Festool pad</TableCell>
                <TableCell>
                  <CategoryLabel category="tools" />
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  $39.99
                </TableCell>
              </TableRow>
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-mono text-2xs text-muted-foreground uppercase">
                  3 items
                </TableCell>
                <TableCell />
                <TableCell className="text-right font-mono tabular-nums">
                  $54.82
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
        <p className="font-mono text-3xs text-muted-foreground">
          The selected row shows the paper tint + ultramarine spine.
        </p>
      </GallerySection>

      <GallerySection
        title="Overlays"
        source="dialog · alert-dialog · dropdown · popover · toast"
      >
        <Row label="Triggers">
          <Dialog>
            <DialogTrigger render={<Button variant="outline">Dialog</Button>} />
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Dialog title</DialogTitle>
                <DialogDescription>
                  Flat ledger panel — hairline frame, square corners, no
                  elevation.
                </DialogDescription>
              </DialogHeader>
              <p className="text-sm">Body content goes here.</p>
              <DialogFooter>
                <Button variant="outline">Cancel</Button>
                <Button>Confirm</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <AlertDialog>
            <AlertDialogTrigger
              render={<Button variant="outline">Alert dialog</Button>}
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this item?</AlertDialogTitle>
                <AlertDialogDescription>
                  This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline">Dropdown</Button>}
            />
            <DropdownMenuContent>
              <DropdownMenuGroup>
                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem>
                  <Package /> View product
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Wrench /> Edit
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <FileText /> Duplicate
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <Popover>
            <PopoverTrigger
              render={<Button variant="outline">Popover</Button>}
            />
            <PopoverContent>
              <PopoverTitle>Popover</PopoverTitle>
              <PopoverDescription>
                A small floating panel, demoted below modals.
              </PopoverDescription>
            </PopoverContent>
          </Popover>

          <Button
            variant="outline"
            onClick={() =>
              toast.success("Saved", { description: "Toast via sonner" })
            }
          >
            Toast
          </Button>
        </Row>

        <Row label="Dialog widths">
          {(["sm", "md", "lg", "xl", "2xl", "full"] as const).map((size) => (
            <Dialog key={size}>
              <DialogTrigger
                render={<Button variant="outline">{size}</Button>}
              />
              <DialogContent size={size}>
                <DialogHeader>
                  <DialogTitle>size=&quot;{size}&quot;</DialogTitle>
                  <DialogDescription>
                    The shared modal width scale. Tall content scrolls inside
                    the capped height.
                  </DialogDescription>
                </DialogHeader>
                <p className="text-sm">Body content goes here.</p>
                <DialogFooter>
                  <Button variant="outline">Cancel</Button>
                  <Button>Confirm</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ))}
        </Row>
      </GallerySection>

      <GallerySection title="Alerts" source="components/common/colored-alert">
        <div className="space-y-2">
          <ColoredAlert variant="info">
            <AlertTitle>Heads up</AlertTitle>
            <AlertDescription>
              Informational message in the slate tone.
            </AlertDescription>
          </ColoredAlert>
          <ColoredAlert variant="warning">
            <AlertTitle>Careful</AlertTitle>
            <AlertDescription>
              Warning message — the reserved semantic orange.
            </AlertDescription>
          </ColoredAlert>
        </div>
      </GallerySection>

      <GallerySection
        title="Misc"
        source="info-row · ticket-divider · skeleton · none"
      >
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-0">
            <p className="mb-1 font-mono text-3xs text-muted-foreground uppercase tracking-wider">
              Fact sheet (dot-leader)
            </p>
            <InfoRow label="UPC">041570052600</InfoRow>
            <InfoRow label="Price">$5.42</InfoRow>
            <InfoRow label="Manufacturer">Blue Diamond</InfoRow>
            <InfoRow label="Notes" />
          </div>
          <div className="space-y-4">
            <div>
              <p className="mb-1 font-mono text-3xs text-muted-foreground uppercase tracking-wider">
                Ticket divider
              </p>
              <TicketDivider />
            </div>
            <div>
              <p className="mb-1 font-mono text-3xs text-muted-foreground uppercase tracking-wider">
                Skeleton
              </p>
              <div className="space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            </div>
            <div>
              <p className="mb-1 font-mono text-3xs text-muted-foreground uppercase tracking-wider">
                Empty value
              </p>
              <NoneValue />
            </div>
          </div>
        </div>
      </GallerySection>

      <GallerySection
        title="Conversion graph"
        source="units/unit-mapping-graph · d3-force"
      >
        <div className="space-y-2">
          <p className="font-mono text-3xs text-muted-foreground uppercase tracking-wider">
            Nodes themed per measure kind · dashed native bridges (g↔lb) ·
            nutrient edges opt-in
          </p>
          <UnitMappingGraph mappings={GRAPH_FIXTURE} includeNutrients />
        </div>
      </GallerySection>

      <GallerySection
        title="Entity preview"
        source="EntityPreviewContent · ui/preview-card"
      >
        <div className="space-y-2">
          <p className="font-mono text-3xs text-muted-foreground uppercase tracking-wider">
            Manifest hovercard shown on any entity link — shared header (icon ·
            name · open · tag · identity) + cross-links + entity-specific body
          </p>
          <div className="flex flex-wrap gap-3">
            {PREVIEW_DEMOS.map(({ key, node }) => (
              <div
                key={key}
                className="w-80 rounded-none border border-[var(--border)] bg-popover p-3 text-popover-foreground text-xs"
              >
                {node}
              </div>
            ))}
          </div>
        </div>
      </GallerySection>

      <GallerySection
        title="Form field groups"
        source="inventory/amount-field-group · units/unit-mapping-pair-field"
      >
        <div className="space-y-2">
          <p className="font-mono text-3xs text-muted-foreground uppercase tracking-wider">
            Fraction-aware amount + unit pair, and the composable “A = B”
            mapping pair (reused by the product unit-conversion editor)
          </p>
          <FormGroupsDemo />
        </div>
      </GallerySection>

      <GallerySection title="Tabs" source="components/ui/tabs">
        <Tabs defaultValue="overview" className="max-w-md">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="nutrition">Nutrition</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="pt-2 text-sm">
            Overview panel content.
          </TabsContent>
          <TabsContent value="nutrition" className="pt-2 text-sm">
            Nutrition panel content.
          </TabsContent>
          <TabsContent value="history" className="pt-2 text-sm">
            History panel content.
          </TabsContent>
        </Tabs>
      </GallerySection>

      <GallerySection
        title="Toggles & view switcher"
        source="components/ui/toggle · view-switcher"
      >
        <div className="space-y-3">
          <Row label="View switch">
            <ViewSwitcherDemo />
          </Row>
        </div>
      </GallerySection>

      <GallerySection
        title="Tooltip & keys"
        source="components/ui/tooltip · kbd"
      >
        <div className="space-y-3">
          <Row label="Tooltip">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={<Button variant="outline">Hover me</Button>}
                />
                <TooltipContent>Tooltip content</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </Row>
          <Row label="Kbd">
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </KbdGroup>
            <Kbd>Esc</Kbd>
          </Row>
        </div>
      </GallerySection>

      <GallerySection title="Spinner" source="components/ui/spinner">
        <Row label="Sizes">
          <Spinner size="sm" />
          <Spinner size="default" />
          <Spinner size="md" />
          <Spinner size="lg" />
        </Row>
      </GallerySection>

      <GallerySection title="Avatar" source="components/ui/avatar">
        <Row label="Group">
          <AvatarGroup>
            <Avatar>
              <AvatarFallback>NS</AvatarFallback>
            </Avatar>
            <Avatar>
              <AvatarFallback>AB</AvatarFallback>
            </Avatar>
            <Avatar>
              <AvatarFallback>CD</AvatarFallback>
            </Avatar>
            <AvatarGroupCount>+3</AvatarGroupCount>
          </AvatarGroup>
        </Row>
      </GallerySection>

      <GallerySection title="Breadcrumb" source="components/ui/breadcrumb">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#">Pantry</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#">Top Shelf</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Spices</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </GallerySection>

      <GallerySection
        title="Separator & collapsible"
        source="components/ui/separator · collapsible"
      >
        <div className="max-w-md space-y-3">
          <div className="text-sm">Above the rule</div>
          <Separator />
          <div className="text-sm">Below the rule</div>
          <Collapsible defaultOpen className="space-y-2">
            <CollapsibleTrigger
              render={
                <Button variant="outline" size="sm">
                  Toggle details <ChevronsUpDown className="ml-1 size-3" />
                </Button>
              }
            />
            <CollapsibleContent className="text-muted-foreground text-sm">
              Collapsible region content.
            </CollapsibleContent>
          </Collapsible>
        </div>
      </GallerySection>

      <GallerySection title="Stat tiles" source="components/ui/stat-tile">
        <StatGrid>
          <StatTile label="Cost / serving">$0.42</StatTile>
          <StatTile label="Calories">90</StatTile>
          <StatTile label="Ingredients">13</StatTile>
          <StatTile label="Coverage">9/13</StatTile>
        </StatGrid>
      </GallerySection>

      <GallerySection title="Empty state" source="components/ui/empty">
        <Empty className="max-w-md border border-[var(--border)]">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox />
            </EmptyMedia>
            <EmptyTitle>No inventory yet</EmptyTitle>
            <EmptyDescription>
              Add your first item to start tracking what’s in the pantry.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm">Add item</Button>
          </EmptyContent>
        </Empty>
      </GallerySection>

      <GallerySection title="Scroll area" source="components/ui/scroll-area">
        <ScrollArea className="h-32 max-w-xs rounded-none border border-[var(--border)] p-3">
          <div className="space-y-1 text-sm">
            {SCROLL_ROWS.map((label) => (
              <div key={label}>{label}</div>
            ))}
          </div>
        </ScrollArea>
      </GallerySection>

      <GallerySection
        title="Inline labels & time"
        source="DotLabel · HoverableTimestamp"
      >
        <div className="space-y-3">
          <Row label="Dot label">
            <DotLabel color="var(--chart-1)">Produce</DotLabel>
            <DotLabel color="var(--chart-3)">Dairy</DotLabel>
            <DotLabel color="var(--chart-5)">Pantry</DotLabel>
          </Row>
          <Row label="Timestamp">
            <HoverableTimestamp timestamp="2026-06-15T12:00:00Z" />
          </Row>
        </div>
      </GallerySection>
    </div>
  );
}

// Static sample data so the manifest bodies render on the (data-less) design
// gallery exactly as they do behind a live hover. Held as typed objects (and
// spread) so the entity-id fields stay out of JSX `id` attributes. Nutrient
// codes: 208 kcal, 203 protein, 204 fat, 205 carbs, 291 fiber, 307 sodium.
const RECIPE_SAMPLE: RecipePreview = {
  id: "sample-recipe",
  shortcode: "RCP-2345",
  name: "RT-Style Chicken Rice Bowl",
  yieldText: "makes 1 serving",
  cost: 0.48,
  calories: 90,
  nutrients: buildNutrients({ protein: 7.2, fat: 3.1, carbs: 6.8, fiber: 1.4 }),
  nutrientsLabel: "Per recipe",
  costCovered: 9,
  nutritionCovered: 8,
  ingredientCount: 13,
  stepCount: 5,
};
const INGREDIENT_SAMPLE: IngredientPreview = {
  id: "sample-ingredient",
  shortcode: "ING-3456",
  name: "cilantro",
  aliases: ["coriander", "fresh coriander"],
  nutrients: buildNutrients({
    kcal: 23,
    protein: 2.1,
    fat: 0.5,
    carbs: 3.7,
    fiber: 2.8,
  }),
  cheapestPrice: 1.99,
  multiplePrices: true,
  recipeCount: 2,
  usdaFdcId: 1103349,
  products: [
    {
      id: "sample-product",
      shortcode: "PRD-0001",
      name: "cilantro",
      manufacturer: "generic",
    },
  ],
};
const PRODUCT_SAMPLE: ProductPreview = {
  id: "sample-product",
  shortcode: "PRD-4567",
  name: "kosher salt",
  identity: "Diamond Crystal · food",
  nutrients: buildNutrients({ sodium: 40000 }),
  price: 11,
  upc: "013600020019",
  usdaFdcId: 2571981,
};
const USDA_SAMPLE: UsdaPreview = {
  fdcId: 2571981,
  name: "KOSHER SALT, KOSHER",
  dataType: "branded_food",
  brand: "Diamond Crystal",
  nutrients: buildNutrients({ sodium: 40000 }),
  linkedProductShortcode: "PRD-2345",
  linkedProductName: "kosher salt",
};
const LOCATION_SAMPLE: LocationPreview = {
  id: "sample-location",
  shortcode: "LOC-5678",
  name: "Top Shelf",
  type: "shelf",
  parent: { shortcode: "LOC-EFGH", name: "Pantry" },
  itemCount: 12,
  subCount: 3,
};
const INVENTORY_SAMPLE: InventoryPreview = {
  id: "sample-inventory",
  shortcode: "INV-6789",
  productName: "Diamond Crystal Kosher Salt",
  productShortcode: "PRD-2345",
  locationName: "Top Shelf",
  locationShortcode: "LOC-5678",
  locationType: "shelf",
  amountText: "3 lb",
  valuation: 11.97,
};
const COOKBOOK_SAMPLE: CookbookPreview = {
  id: "sample-cookbook",
  shortcode: "CKB-789A",
  name: "Salt Fat Acid Heat",
  authors: ["Samin Nosrat"],
  subjects: ["Cooking", "Technique"],
  recipeCount: 41,
  sourceRecipeCount: 86,
};
const MEAL_SAMPLE: MealPreview = {
  id: "sample-meal",
  shortcode: "MEL-89AB",
  name: "Sunday Supper",
  date: "2026-08-09",
  recipeNames: ["Buttermilk-Brined Chicken", "Kale Caesar"],
  cost: 18.4,
  calories: 2140,
  pending: false,
};
const PROJECT_SAMPLE: ProjectPreview = {
  id: "PRJ-9ABC",
  name: "Backyard Deck Rebuild",
  icon: "🔨",
  status: "in_progress",
  kind: "renovation",
  locations: ["Home"],
  spent: 1240,
  costEstimate: 2000,
  taskCount: 8,
  doneTaskCount: 5,
  expenseCount: 6,
};
const TASK_SAMPLE: TaskPreview = {
  id: "TSK-ABCD",
  name: "Sand and stain the railing",
  status: "in_progress",
  trade: "finishes",
  dueDate: "2026-08-01",
  dueEndDate: null,
  projectId: "PRJ-9ABC",
  projectName: "Backyard Deck Rebuild",
};
const EXPENSE_SAMPLE: ExpensePreview = {
  id: "EXP-BCDE",
  name: "Cedar decking boards",
  cost: 340,
  date: "2026-07-10",
  costType: "materials",
  trade: "building",
  future: false,
  projectId: "PRJ-9ABC",
  projectName: "Backyard Deck Rebuild",
};
// A charge whose lines don't quite add up to what the receipt stated — the
// reconciliation caption is the whole point of the card, so the sample shows it.
const PURCHASE_SAMPLE: PurchasePreview = {
  id: "PUR-CDEF",
  orderId: "WN63446464",
  date: "2026-07-10",
  statedTotal: 412.18,
  expenseCount: 3,
  expenseTotal: 396.4,
  vendorId: "VEN-DEFG",
  vendorName: "Home Depot",
};
const VENDOR_SAMPLE: VendorPreview = {
  id: "VEN-DEFG",
  name: "Home Depot",
  purchaseCount: 27,
  spend: 8412.55,
};

const PREVIEW_DEMOS = [
  { key: "recipe", node: <ManifestCard {...toRecipeCard(RECIPE_SAMPLE)} /> },
  {
    key: "ingredient",
    node: <ManifestCard {...toIngredientCard(INGREDIENT_SAMPLE)} />,
  },
  { key: "product", node: <ManifestCard {...toProductCard(PRODUCT_SAMPLE)} /> },
  { key: "usda-food", node: <ManifestCard {...toUsdaCard(USDA_SAMPLE)} /> },
  {
    key: "cookbook",
    node: <ManifestCard {...toCookbookCard(COOKBOOK_SAMPLE)} />,
  },
  {
    key: "location",
    node: <ManifestCard {...toLocationCard(LOCATION_SAMPLE)} />,
  },
  {
    key: "inventory",
    node: <ManifestCard {...toInventoryCard(INVENTORY_SAMPLE)} />,
  },
  { key: "meal", node: <ManifestCard {...toMealCard(MEAL_SAMPLE)} /> },
  { key: "project", node: <ManifestCard {...toProjectCard(PROJECT_SAMPLE)} /> },
  { key: "task", node: <ManifestCard {...toTaskCard(TASK_SAMPLE)} /> },
  {
    key: "expense",
    node: <ManifestCard {...toExpenseCard(EXPENSE_SAMPLE)} />,
  },
  {
    key: "purchase",
    node: <ManifestCard {...toPurchaseCard(PURCHASE_SAMPLE)} />,
  },
  { key: "vendor", node: <ManifestCard {...toVendorCard(VENDOR_SAMPLE)} /> },
] as const;
