import { locationTypeValues, productCategoryValues } from "@cubby/shared";
import { Bell, FileText, Layers, Package, Wrench } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { EntityPillLink } from "~/app/_components/EntityPill";
import { LocationTypeBadge } from "~/app/_components/locations/LocationTypeBadge";
import { NoneState } from "~/app/_components/NoneState";
import { CategoryBadge } from "~/app/_components/products/CategoryBadge";
import {
  DistributionGlyph,
  StripPlotCell,
} from "~/app/_components/recipe/compare/DeviationBar";
import { DecompositionView } from "~/app/_components/recipe/decomposition-view";
import { RecipeTag } from "~/app/_components/recipe/recipe-tag";
import { ImageStatusBadge } from "~/app/_components/table/StatusBadge";
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
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SelectableCard,
} from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { InkStamp } from "~/components/ui/ink-stamp";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { QuantityInput } from "~/components/ui/quantity-input";
import { Skeleton } from "~/components/ui/skeleton";
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
import { Textarea } from "~/components/ui/textarea";
import { TicketDivider } from "~/components/ui/ticket-divider";
import { INGREDIENT_PART_COLOR } from "~/lib/ingredient-part-colors";

/** Surface + semantic palette tokens, grouped for the swatch grid. */
const SURFACE_TOKENS = [
  "--background",
  "--card",
  "--muted",
  "--accent",
  "--secondary",
  "--border",
  "--border-chunky",
  "--input",
];
const SEMANTIC_TOKENS = [
  "--primary",
  "--destructive",
  "--positive",
  "--eyebrow",
  "--plum",
  "--slate",
  "--subtle",
  "--glow",
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

function Swatch({ token }: { token: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="h-12 w-full rounded-md border border-border"
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
      <div className="flex items-baseline justify-between gap-2 border-[var(--border-chunky)] border-b pb-1">
        <h2 className="border-0 p-0 font-mono text-eyebrow text-sm uppercase tracking-wider">
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

      <GallerySection title="Typography" source="styles.css @layer base">
        <div className="space-y-2">
          <h1>Heading 1 — Fraunces display</h1>
          <h2 className="border-0 p-0">Heading 2 — Fraunces</h2>
          <h3 className="font-heading font-semibold text-lg">
            Heading 3 — Fraunces
          </h3>
          <p className="text-sm">
            Body copy is Inter. The quick brown fox jumps over the lazy dog —
            crisp, neutral, legible at small sizes.
          </p>
          <p className="font-mono text-xs">
            Mono is JetBrains Mono — used on chrome, codes, and numerals:
            041570052600 · $9.41 · 248
          </p>
          <p className="font-mono text-2xs text-eyebrow uppercase tracking-wider">
            Eyebrow micro-label
          </p>
          <div className="flex items-baseline gap-4 text-muted-foreground">
            <span className="text-3xs">text-3xs</span>
            <span className="text-2xs">text-2xs</span>
            <span className="text-xs">text-xs</span>
            <span className="text-sm">text-sm</span>
            <span className="text-base">text-base</span>
          </div>
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
            <Button size="lg">lg</Button>
          </Row>
          <Row label="Icon">
            <Button size="icon-xs" aria-label="bell">
              <Bell />
            </Button>
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
        source="badge · DotLabel · EntityPillLink"
      >
        <div className="space-y-3">
          <Row label="Badge">
            <Badge>default</Badge>
            <Badge variant="secondary">secondary</Badge>
            <Badge variant="outline">outline</Badge>
            <Badge variant="destructive">destructive</Badge>
            <Badge variant="ghost">ghost</Badge>
          </Row>
          <Row label="Categories">
            {productCategoryValues.map((c) => (
              <CategoryBadge key={c} category={c} />
            ))}
          </Row>
          <Row label="Location types">
            {locationTypeValues.slice(0, 7).map((t) => (
              <LocationTypeBadge key={t} type={t} />
            ))}
          </Row>
          <Row label="Entity links">
            <EntityPillLink
              entity="ingredient"
              data={{ id: "1", name: "almond butter" }}
            />
            <EntityPillLink
              entity="product"
              data={{
                id: "1",
                name: "Cyclone 200ES",
                manufacturer: "Everlast",
              }}
            />
            <EntityPillLink
              entity="recipe"
              data={{ id: "1", name: "Za'atar" }}
            />
            <EntityPillLink
              entity="location"
              data={{ id: "1", name: "Chrome Wire Shelf", type: "shelf" }}
            />
            <EntityPillLink
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
              One surface — hairline border + soft elevation. Eyebrow title
              takes an optional <code>icon</code>.
            </CardContent>
          </Card>
          <DashboardCard icon={Layers} title="Dashboard card">
            <p className="text-sm">
              Same surface + an icon-eyebrow header helper.
            </p>
          </DashboardCard>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <SelectableCard selected>
            <span className="font-medium text-sm">Selectable — selected</span>
            <span className="text-muted-foreground text-xs">
              Primary border + elevation
            </span>
          </SelectableCard>
          <SelectableCard>
            <span className="font-medium text-sm">Selectable — idle</span>
            <span className="text-muted-foreground text-xs">Inner ring</span>
          </SelectableCard>
        </div>
      </GallerySection>

      <GallerySection title="Table" source="components/ui/table">
        <div className="overflow-hidden rounded-lg border border-[var(--border-chunky)] shadow-[var(--shadow-chunky)]">
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
                  <CategoryBadge category="food" />
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  $5.42
                </TableCell>
              </TableRow>
              <TableRow data-state="selected">
                <TableCell className="font-medium">rolled oats</TableCell>
                <TableCell>
                  <CategoryBadge category="food" />
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  $9.41
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Festool pad</TableCell>
                <TableCell>
                  <CategoryBadge category="tools" />
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
          The selected row shows the warm tint + terracotta spine.
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
                  Signature chrome frame with layered elevation.
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
              <NoneState />
            </div>
          </div>
        </div>
      </GallerySection>
    </div>
  );
}
