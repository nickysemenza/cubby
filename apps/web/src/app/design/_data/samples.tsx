import type { ReportBlock } from "@cubby/schemas/entity-report";
import { locationShortcode } from "@cubby/schemas/identifiers";
import type { infLocation, LocationType } from "@cubby/schemas/location";
import type { unitMappingWithMetadata } from "@cubby/schemas/unitmapping";
import type { WorkQueueGap } from "@cubby/schemas/work-queue";
import { SHORTCODE_CHARS } from "@cubby/shared";
import { z } from "zod";

import { formatCurrency } from "~/lib/number-format";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import type { PickerOption } from "~/ui/combobox/picker-option";

// Deterministic ids/shortcodes for these static demo fixtures. We must NOT call
// crypto.randomUUID() / random shortcode generation at module top-level: workerd
// disallows generating random values in module (global) scope, and this module
// is evaluated during SSR — which crashed renderToReadableStream. A simple
// counter keeps the ids stable and unique, which is all the demos need.
const now = new Date(0);
const ts = { createdAt: now, updatedAt: now };
let locationSeq = 0;
const shortcodeAlphabet = SHORTCODE_CHARS;

// A demo fixture has nothing to say about data quality — every scored
// entity's read shape still requires the field.
const demoDataQuality = {
  status: "complete" as const,
  score: 100,
  facets: [],
  gaps: [],
  exceptions: [],
  relatedGaps: [],
  relatedExceptions: [],
};

// Helper to create a location
const makeLocation = (
  name: string,
  type: LocationType,
  children?: z.infer<typeof infLocation>[],
): z.infer<typeof infLocation> => {
  locationSeq += 1;
  const suffix = shortcodeAlphabet[locationSeq];
  if (!suffix) throw new Error("Location demo fixture capacity exceeded");
  const location: z.infer<typeof infLocation> = {
    id: locationShortcode.parse(`LOC-222${suffix}`),
    name,
    aliases: [],
    product: null,
    type,
    lastBulkInventory: null,
    aiDescription: null,
    notes: null,
    images: [],
    valuation: null,
    dataQuality: demoDataQuality,
    ...ts,
  };
  if (children !== undefined) location.children = children;
  return location;
};

// Zod schema for rich text input (raw text + ingredient names for parsing)
export const richTextInputSchema = z.object({
  text: z.string(),
  ingredientNames: z.array(z.string()),
});

// Sample data for ConversionCapabilities
export const sampleUnitMappings: z.infer<typeof unitMappingWithMetadata>[] = [
  {
    a: { value: 1, unit: "cup" },
    b: { value: 125, unit: "g" },
    source: "USDA",
    sourceMetadata: { type: "food", fdcId: 12345 },
  },
  {
    a: { value: 1, unit: "cup" },
    b: { value: 2.5, unit: "$" },
    source: "Manual",
    sourceMetadata: { type: "manual" },
  },
  {
    a: { value: 1, unit: "lb" },
    b: { value: 453.592, unit: "g" },
    source: "Standard",
    sourceMetadata: { type: "manual" },
  },
];

// Sample data for formatRichText - raw instruction text and ingredient names
export const sampleRichTextInput = {
  text: "Add 2 cups of flour and 1 tsp of salt to the bowl.",
  ingredientNames: ["flour", "salt"],
};

// Sample data for LocationTreeView
export const sampleLocations: z.infer<typeof infLocation>[] = [
  makeLocation("Kitchen", "room", [
    makeLocation("Pantry", "cabinet", [
      makeLocation("Top Shelf", "shelf"),
      makeLocation("Bottom Shelf", "shelf"),
    ]),
    makeLocation("Refrigerator", "cabinet", [
      makeLocation("Crisper Drawer", "drawer"),
    ]),
  ]),
  makeLocation("Garage", "room", [makeLocation("Chest Freezer", "cabinet")]),
];

// ---------------------------------------------------------------------------
// /design showcase fixtures. Everything below is synthetic and deterministic:
// emojis are indexed, never `Math.random()`, so the page and its screenshots
// render the same on every load (and module scope stays random-free for SSR).

export type DemoDomain = "cook" | "pantry" | "plan" | "house" | "finance";

/** placehold.co takes hex colours, not CSS variables: a soft surface and its ink per domain. */
const DOMAIN_HEX = {
  cook: ["f6e7da", "9a4f1f"],
  pantry: ["e6efdc", "4f6b2a"],
  plan: ["e3e9f5", "3b5794"],
  house: ["efe6f3", "6c4a85"],
  finance: ["e0f0ec", "2f6f5e"],
} as const satisfies Record<DemoDomain, readonly [string, string]>;

/** A labelled placeholder picture sized for the slot it fills. */
function placeholderImage(
  text: string,
  domain: DemoDomain,
  width = 160,
  height = width,
): string {
  const [surface, ink] = DOMAIN_HEX[domain];
  return `https://placehold.co/${width}x${height}/${surface}/${ink}/png?text=${encodeURIComponent(text)}`;
}

const DEMO_EMOJIS = [
  "🥛",
  "🍞",
  "🍚",
  "☕",
  "🫒",
  "🧼",
  "💡",
  "🍅",
  "🌶️",
  "🧻",
  "🥕",
  "🧂",
  "🍯",
  "🪴",
  "🧺",
  "🔋",
  "🧀",
  "🍋",
  "🪥",
  "🫖",
] as const;

/** The same record always gets the same emoji. */
const demoEmoji = (index: number): string =>
  DEMO_EMOJIS[index % DEMO_EMOJIS.length]!;

export interface DemoProduct {
  id: string;
  name: string;
  emoji: string;
  domain: DemoDomain;
  location: string;
  category: string;
  onHand: number;
  price: number | null;
  purchasedOn: string | null;
  updatedAt: string;
  images: { id: string; url: string; filename: string }[];
}

const product = (
  index: number,
  name: string,
  domain: DemoDomain,
  location: string,
  category: string,
  onHand: number,
  price: number | null,
  purchasedOn: string | null,
  updatedAt: string,
  withImage = true,
): DemoProduct => ({
  id: `demo-product-${index}`,
  name,
  emoji: demoEmoji(index),
  domain,
  location,
  category,
  onHand,
  price,
  purchasedOn,
  updatedAt,
  images: withImage
    ? [
        {
          id: `demo-image-${index}`,
          url: placeholderImage(name, domain),
          filename: `${name}.png`,
        },
      ]
    : [],
});

export const demoProducts: DemoProduct[] = [
  product(
    0,
    "Oat milk",
    "pantry",
    "Fridge door",
    "dairy",
    2,
    3.49,
    "2026-10-02",
    "2026-10-13T08:15:00Z",
  ),
  product(
    1,
    "Sourdough loaf",
    "cook",
    "Bread box",
    "bakery",
    1,
    6.5,
    "2026-10-12",
    "2026-10-12T17:40:00Z",
  ),
  product(
    2,
    "Basmati rice",
    "pantry",
    "Pantry · Top shelf",
    "grains",
    3,
    12.99,
    "2026-09-18",
    "2026-10-01T10:00:00Z",
  ),
  product(
    3,
    "Cold brew concentrate",
    "pantry",
    "Fridge door",
    "drinks",
    0,
    9.25,
    "2026-08-30",
    "2026-09-29T07:05:00Z",
  ),
  product(
    4,
    "Olive oil",
    "cook",
    "Pantry · Bottom shelf",
    "oils",
    1,
    18,
    "2026-07-11",
    "2026-09-02T19:30:00Z",
  ),
  product(
    5,
    "Dish soap",
    "house",
    "Under the sink",
    "cleaning",
    2,
    4.75,
    "2026-09-25",
    "2026-10-10T12:00:00Z",
  ),
  product(
    6,
    "Light bulbs (4-pack)",
    "house",
    "Hall closet",
    "hardware",
    4,
    11.4,
    null,
    "2026-06-21T15:45:00Z",
    false,
  ),
  product(
    7,
    "Tomato seeds",
    "plan",
    "Garage · Seed tin",
    "garden",
    30,
    3.2,
    "2026-03-04",
    "2026-04-17T09:20:00Z",
  ),
  product(
    8,
    "Hot sauce",
    "cook",
    "Fridge door",
    "condiments",
    1,
    null,
    null,
    "2025-12-28T18:10:00Z",
  ),
  product(
    9,
    "Paper towels",
    "house",
    "Garage · Shelf B",
    "paper",
    6,
    21.99,
    "2026-10-08",
    "2026-10-08T16:25:00Z",
  ),
];

export const demoCategoryOptions: PickerOption[] = [
  { value: "dairy", label: "Dairy", icon: "🥛" },
  { value: "bakery", label: "Bakery", icon: "🍞" },
  { value: "grains", label: "Grains", icon: "🍚" },
  { value: "drinks", label: "Drinks", icon: "☕" },
  { value: "oils", label: "Oils", icon: "🫒" },
  { value: "condiments", label: "Condiments", icon: "🌶️" },
  { value: "cleaning", label: "Cleaning", icon: "🧼" },
  { value: "hardware", label: "Hardware", icon: "💡" },
  { value: "garden", label: "Garden", icon: "🌱" },
  { value: "paper", label: "Paper goods", icon: "🧻" },
];

/**
 * Picker rows for the products: a picture, a muted location, mono price and
 * on-hand chips. A function, because currency formatting runs in WASM and so
 * belongs at render time, not module scope.
 */
export const demoProductItems = (): ComboboxItem[] =>
  demoProducts.map((item) => ({
    id: item.id,
    name: item.name,
    secondary: item.location,
    thumb: {
      imageUrl: item.images[0]?.url ?? null,
      fallback: <span className="text-xs">{item.emoji}</span>,
    },
    presentation: {
      group: {
        id: item.domain,
        label: item.domain[0]!.toUpperCase() + item.domain.slice(1),
        order: Object.keys(DOMAIN_HEX).indexOf(item.domain),
      },
      trailing: [
        ...(item.price === null ? [] : [{ text: formatCurrency(item.price) }]),
        {
          text: `${item.onHand} on hand`,
          ...(item.onHand === 0 && { tone: "warning" as const }),
        },
      ],
    },
  }));

export const demoStorageOptions: PickerOption[] = [
  { value: "fridge", label: "Fridge", icon: "🧊" },
  { value: "freezer", label: "Freezer", icon: "❄️" },
  { value: "pantry", label: "Pantry", icon: "🥫" },
  { value: "counter", label: "Counter", icon: "🧺" },
  {
    value: "cellar",
    label: "Cellar",
    icon: "🍷",
    disabledReason: "No cellar is recorded for this home",
  },
];

export const demoStatusOptions: PickerOption[] = [
  { value: "__any", label: "Has a status", meta: true },
  { value: "stocked", label: "Stocked", color: "var(--positive)", hint: "42" },
  { value: "low", label: "Running low", color: "var(--warning)", hint: "7" },
  { value: "out", label: "Out", color: "var(--destructive)", hint: "3" },
  { value: "retired", label: "Retired", color: "var(--slate)", hint: "12" },
];

/** A hierarchy: quiet group headings and indent instead of a breadcrumb per row. */
const location = (
  value: string,
  label: string,
  depth: number,
  icon: string,
): PickerOption => ({
  value,
  label,
  depth,
  icon,
  group: value.startsWith("kitchen")
    ? { id: "kitchen", label: "Kitchen", order: 0 }
    : { id: "garage", label: "Garage", order: 1 },
});

export const demoLocationOptions: PickerOption[] = [
  location("kitchen", "Kitchen", 0, "🍳"),
  location("kitchen-pantry", "Pantry", 1, "🥫"),
  location("kitchen-pantry-top", "Top shelf", 2, "📦"),
  location("kitchen-fridge", "Fridge", 1, "🧊"),
  location("garage", "Garage", 0, "🚗"),
  location("garage-shelf-b", "Shelf B", 1, "📦"),
  location("garage-seed-tin", "Seed tin", 1, "🌱"),
];

// ---------------------------------------------------------------------------
// Report records blocks, the shape the server sends every client.

const at = (time: string) => `2026-10-13T${time}:00-07:00`;

export const demoLedgerBlock: ReportBlock = {
  kind: "records",
  title: "Purchases of this Product",
  empty: "No purchases yet.",
  rows: [
    {
      entity: null,
      id: null,
      title: "Corner grocer · 2 cartons",
      trailing: "$6.98",
      imageUrl: placeholderImage("Receipt", "finance", 64),
      at: at("09:12"),
      badges: [{ label: "Itemized", tone: "positive" }],
      lines: [
        { text: "Matched by barcode" },
        { text: "Order Email · line 3 of 11", tone: "muted" },
      ],
    },
    {
      entity: null,
      id: null,
      title: "Weekly delivery · 4 cartons",
      trailing: "$13.20",
      imageUrl: placeholderImage("Order", "finance", 64),
      at: at("11:48"),
      badges: [
        { label: "Price changed", tone: "warning" },
        { label: "Subscription" },
      ],
      lines: [{ text: "Was $3.15 a carton last order", tone: "muted" }],
    },
    {
      entity: null,
      id: null,
      title: "Farmers market",
      trailing: null,
      at: at("16:30"),
      badges: [{ label: "No receipt", tone: "muted" }],
      lines: [
        {
          text: "Cash purchase: amount was never recorded, so this line adds nothing to spend.",
          tone: "warning",
        },
      ],
    },
  ],
  footer: "3 purchases · $20.18 recorded",
};

export const demoTimelineBlock: ReportBlock = {
  kind: "records",
  presentation: "timeline",
  title: "Import pipeline",
  empty: "This import has not started.",
  rows: [
    {
      entity: null,
      id: null,
      title: "Receive order Email",
      trailing: null,
      at: at("08:00"),
      state: { kind: "done", label: "Received" },
      lines: [{ text: "1 Email, 2 attachments" }],
    },
    {
      entity: null,
      id: null,
      title: "Extract lines",
      trailing: "11",
      at: at("08:01"),
      state: { kind: "done", label: "Extracted" },
      lines: [{ text: "11 lines, 1 discount", tone: "muted" }],
    },
    {
      entity: null,
      id: null,
      title: "Match Products",
      trailing: "9 / 11",
      at: at("08:02"),
      state: { kind: "warning", label: "Matched with gaps" },
      badges: [{ label: "2 unmatched", tone: "warning" }],
      lines: [
        {
          text: "Two lines need a Product before they can be itemized.",
          tone: "warning",
        },
      ],
    },
    {
      entity: null,
      id: null,
      title: "Price lines",
      trailing: null,
      at: at("08:02"),
      state: { kind: "failed", label: "Failed" },
      lines: [
        {
          text: "E_TOTAL_MISMATCH: lines sum to $48.10, stated total is $51.60",
          tone: "destructive",
        },
      ],
    },
    {
      entity: null,
      id: null,
      title: "Retry pricing",
      trailing: null,
      at: at("08:05"),
      state: { kind: "running", label: "Running" },
      lines: [{ text: "Including the delivery fee line", tone: "muted" }],
    },
    {
      entity: null,
      id: null,
      title: "Enrich images",
      trailing: null,
      state: { kind: "skipped", label: "Skipped" },
      lines: [
        { text: "Every matched Product already has a cover", tone: "muted" },
      ],
    },
    {
      entity: null,
      id: null,
      title: "Post to the ledger",
      trailing: null,
      state: { kind: "not_reached", label: "Not reached" },
    },
  ],
};

const FILMSTRIP_DOMAINS = [
  "pantry",
  "cook",
  "plan",
  "house",
  "finance",
] as const;

export const demoFilmstripBlock: ReportBlock = {
  kind: "records",
  presentation: "filmstrip",
  title: "Label photos",
  empty: "No photos yet.",
  thumbnail: "large",
  rows: ["Front", "Nutrition", "Ingredients", "Barcode", "Back"].map(
    (title, index) => ({
      entity: null,
      id: null,
      title,
      trailing: null,
      imageUrl: placeholderImage(title, FILMSTRIP_DOMAINS[index]!, 640, 480),
      at: at(`10:0${index}`),
    }),
  ),
};

/** Work queue gaps: one chip per failed check, defects destructive. */
export const demoGaps: WorkQueueGap[] = [
  { check: "product_image", message: "Stocked, but no cover photo yet" },
  { check: "product_price", message: "No purchase records a price" },
  { check: "product_category", message: "Pick a category so spend rolls up" },
  { check: "product_manufacturer", message: "Manufacturer is blank" },
];
