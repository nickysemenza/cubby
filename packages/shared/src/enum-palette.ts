/** Adaptive roles from design-tokens/tokens.json, shared by compiled web and Apple rosters. */
const CATEGORY_COLORS = [
  "var(--category-1)",
  "var(--category-2)",
  "var(--category-3)",
  "var(--category-4)",
  "var(--category-5)",
  "var(--category-6)",
  "var(--category-7)",
  "var(--category-8)",
] as const;

const LEGACY_COLORS = new Map([
  ["var(--chart-1)", "var(--category-1)"],
  ["var(--chart-2)", "var(--category-3)"],
  ["var(--chart-3)", "var(--category-1)"],
  ["var(--chart-4)", "var(--category-5)"],
  ["var(--chart-5)", "var(--category-4)"],
  ["var(--chart-6)", "var(--category-2)"],
  ["var(--chart-positive)", "var(--positive)"],
  ["var(--chart-negative)", "var(--destructive)"],
  ["var(--chart-neutral)", "var(--neutral-status)"],
  ["var(--muted-foreground)", "var(--neutral-status)"],
  ["var(--primary)", "var(--info)"],
  ["var(--plum)", "var(--category-5)"],
]);

/**
 * Condition colors. An option whose color is one of these reads as a state
 * (filled tint + glyph); anything else is a category (quiet matching tint).
 */
const CONDITION_COLORS = new Set([
  "var(--positive)",
  "var(--warning)",
  "var(--destructive)",
  "var(--info)",
  "var(--neutral-status)",
]);

/** A roster's visual role: `status` options are states, `category` options are kinds. */
export const enumRoles = ["status", "category"] as const;
export type EnumRole = (typeof enumRoles)[number];

/** One glyph for both clients: a Phosphor component name and an SF Symbol. */
export interface EnumIcon {
  phosphor: string;
  sfSymbol: string;
}

const STATUS_ICONS = new Map<string, EnumIcon>([
  [
    "var(--positive)",
    { phosphor: "CheckCircle", sfSymbol: "checkmark.circle.fill" },
  ],
  ["var(--warning)", { phosphor: "Clock", sfSymbol: "clock" }],
  [
    "var(--destructive)",
    { phosphor: "XCircle", sfSymbol: "xmark.circle.fill" },
  ],
  [
    "var(--info)",
    { phosphor: "CircleHalf", sfSymbol: "circle.lefthalf.filled" },
  ],
  [
    "var(--neutral-status)",
    { phosphor: "CircleDashed", sfSymbol: "circle.dashed" },
  ],
]);

const VALUE_ICONS = new Map<string, EnumIcon>([
  ...glyphs(
    "Question",
    "questionmark.circle",
    "unknown unclassified unspecified unverified",
  ),
  ["blocked", { phosphor: "Prohibit", sfSymbol: "nosign" }],
  ["paused", { phosphor: "PauseCircle", sfSymbol: "pause.circle" }],
  ["planned", { phosphor: "CalendarDots", sfSymbol: "calendar" }],
  ["planning", { phosphor: "CalendarDots", sfSymbol: "calendar" }],
  ["waiting", { phosphor: "Hourglass", sfSymbol: "hourglass" }],
]);

/** Shared option meanings; a declaration overrides these when a field needs a more specific mark. */
function glyphs(
  phosphor: string,
  sfSymbol: string,
  values: string,
): Array<[string, EnumIcon]> {
  return values
    .split(" ")
    .map((value) => [valueKey(value), { phosphor, sfSymbol }]);
}

const CATEGORY_ICONS = new Map<string, EnumIcon>([
  ...glyphs("SealCheck", "checkmark.seal", "complete complete_with_exceptions"),
  ...glyphs("ClipboardText", "list.clipboard", "needs_data"),
  ...glyphs("Warning", "exclamationmark.triangle", "defect"),
  ...glyphs("Question", "questionmark.circle", "not_assessed"),
  ...glyphs("PencilSimple", "pencil", "explicit"),
  ...glyphs("Clock", "clock", "legacy"),
  ...glyphs("FileText", "doc.text", "source"),
  ...glyphs("ArrowClockwise", "arrow.clockwise", "evidence_changed"),
  ...glyphs("CircleDashed", "circle.dashed", "not_imported"),
  ...glyphs(
    "Leaf",
    "leaf",
    "basil cabbage celery chard collard kale leek lettuce mustard rhubarb spinach asian-greens broccoli-raab cilantro dill parsley sorrel shiso epazote fenugreek scallion celery-leaf mint thyme oregano mexican-oregano chives garlic-chives rau-ram hoja-santa curry-leaf",
  ),
  ...glyphs(
    "Carrot",
    "carrot",
    "beet carrot kohlrabi parsnip potato radish turnip rutabaga garlic onion shallot",
  ),
  ...glyphs(
    "Plant",
    "leaf",
    "artichoke bean-fava bean-runner bean-snap broccoli brussels-sprout cauliflower cucumber eggplant pea squash-summer squash-winter tomato pumpkin tomatillo bean-yardlong",
  ),
  ...glyphs("Grains", "leaf", "corn"),
  ...glyphs("Pepper", "carrot", "pepper sichuan-pepper"),
  ...glyphs(
    "OrangeSlice",
    "leaf",
    "melon watermelon strawberry passion-fruit citrus plum",
  ),
  ...glyphs(
    "Flower",
    "camera.macro",
    "sunflower saffron alyssum nasturtium marigold poppy",
  ),
  ...glyphs(
    "Question",
    "questionmark.circle",
    "unknown unclassified unspecified uncertain maybe",
  ),
  ...glyphs(
    "CircleDashed",
    "circle.dashed",
    "none not_applicable not_expected not_started unassigned other __none__",
  ),
  ...glyphs(
    "ShoppingCart",
    "cart",
    "mixed_retail purchased purchase purchase_validation wanted",
  ),
  ...glyphs("Carrot", "carrot", "food_retail"),
  ...glyphs("Coffee", "cup.and.saucer", "coffee_shop"),
  ...glyphs(
    "ForkKnife",
    "fork.knife",
    "restaurant food eating_out takeout cooked lunch dinner brunch",
  ),
  ...glyphs("SunHorizon", "sunrise", "breakfast"),
  ...glyphs("Cookie", "birthday.cake", "dessert snack"),
  ...glyphs("Archive", "archivebox", "leftovers storage"),
  ...glyphs(
    "Receipt",
    "receipt",
    "receipt_only itemized_match itemized_mismatch recorded",
  ),
  ...glyphs("Globe", "globe", "online_account"),
  ...glyphs(
    "Package",
    "shippingbox",
    "consumable supplies materials box durable",
  ),
  ...glyphs("Gift", "gift", "gift"),
  ...glyphs(
    "ArrowCounterClockwise",
    "arrow.uturn.backward",
    "previously_owned refund refund_adjusted",
  ),
  ...glyphs(
    "CreditCard",
    "creditcard",
    "credit_card amex visa mastercard discover credit_card_payment",
  ),
  ...glyphs("Bank", "building.columns", "bank_account account_sync"),
  ...glyphs("Money", "banknote", "cash stored_value"),
  ...glyphs(
    "ArrowsLeftRight",
    "arrow.left.arrow.right",
    "account_transfer internal_move reimbursement contribution household_distribution adjustment other_adjustment allocation shared",
  ),
  ...glyphs(
    "CurrencyDollar",
    "dollarsign.circle",
    "income interest principal fee tip",
  ),
  ...glyphs("Percent", "percent", "tax discount"),
  ...glyphs("Truck", "truck.box", "shipping logistics"),
  ...glyphs("Storefront", "storefront", "vendor"),
  ...glyphs("Handshake", "hands.clap", "services"),
  ...glyphs("TShirt", "tshirt", "apparel"),
  ...glyphs("BookOpen", "book", "books"),
  ...glyphs("Cpu", "cpu", "electronics"),
  ...glyphs("Code", "chevron.left.forwardslash.chevron.right", "software"),
  ...glyphs(
    "Wrench",
    "wrench.and.screwdriver",
    "hardware tools tool-accessories tool-consumables maintenance installed renovation mechanical",
  ),
  ...glyphs("Oven", "oven", "appliances"),
  ...glyphs("Car", "car", "auto"),
  ...glyphs("Hammer", "hammer", "building demolition"),
  ...glyphs("House", "house", "house household room"),
  ...glyphs("MapPin", "mappin.and.ellipse", "area"),
  ...glyphs("Bed", "bed.double", "bed"),
  ...glyphs("SquaresFour", "cabinet", "cabinet cabinetry drawer"),
  ...glyphs("Table", "table.furniture", "countertop table"),
  ...glyphs("Stack", "square.3.layers.3d", "shelf flooring"),
  ...glyphs("Couch", "sofa", "furniture"),
  ...glyphs("Plant", "leaf", "garden landscaping planter growing"),
  ...glyphs("Leaf", "leaf", "open-pollinated stock"),
  ...glyphs("Flower", "camera.macro", "hybrid"),
  ...glyphs("Basket", "basket", "harvest"),
  ...glyphs("Bag", "bag", "bag"),
  ...glyphs("ShoppingBag", "cart", "cart acquired"),
  ...glyphs("PaintRoller", "paintbrush", "finishes drywall"),
  ...glyphs("Lightning", "bolt", "electrical"),
  ...glyphs("Drop", "drop", "plumbing"),
  ...glyphs("Ruler", "ruler", "millwork"),
  ...glyphs("Hammer", "hammer", "metalworking"),
  ...glyphs("Palette", "paintpalette", "crafts"),
  ...glyphs("AirplaneTilt", "airplane", "travel trip"),
  ...glyphs("Gear", "gearshape", "workshop"),
  ...glyphs("DeviceMobile", "iphone", "ios waiting_for_device"),
  ...glyphs("Desktop", "desktopcomputer", "macos"),
  ...glyphs(
    "Image",
    "photo",
    "own screenshot photo_inventory identify_image describe_image subject_lift",
  ),
  ...glyphs(
    "MagnifyingGlass",
    "magnifyingglass",
    "catalog discovery mail_discovery source_discovered needs_review researching",
  ),
  ...glyphs(
    "Sparkle",
    "sparkles",
    "ai_refresh ai_suggest product_enrichment suggested suggestion_sweep",
  ),
  ...glyphs(
    "ArrowClockwise",
    "arrow.clockwise",
    "backfill derived_refresh retry sweep",
  ),
  ...glyphs(
    "FileArrowDown",
    "square.and.arrow.down",
    "file_import mail_import importing imported import_completed",
  ),
  ...glyphs("Envelope", "envelope", "mail_reclassify mail_search"),
  ...glyphs("Eye", "eye", "foreground"),
  ...glyphs("EyeSlash", "eye.slash", "background excluded"),
  ...glyphs("Clock", "clock", "ephemeral scheduled pending"),
  ...glyphs("Hand", "hand.raised", "manual"),
  ...glyphs(
    "Users",
    "person.2",
    "member guest member_request household_distribution",
  ),
  ...glyphs("Link", "link", "linked related"),
  ...glyphs("LinkBreak", "link.badge.minus", "unrelated unrelated_source"),
  ...glyphs("NotePencil", "square.and.pencil", "note"),
  ...glyphs("ClipboardText", "list.clipboard", "rule decision resolution"),
  ...glyphs("ArrowBendDownRight", "arrow.turn.down.right", "inherit"),
  ...glyphs("ListBullets", "list.bullet", "item_line"),
  ...glyphs("Cube", "cube", "model"),
  ...glyphs("Key", "key", "leased"),
  ...glyphs("Lock", "lock", "paused_auth"),
  ...glyphs("WifiSlash", "wifi.slash", "paused_offline"),
  ...glyphs("SkipForward", "forward.end", "skipped"),
  ...glyphs("UploadSimple", "square.and.arrow.up", "uploaded"),
  ...glyphs("Prohibit", "nosign", "not_allowed void"),
  ...glyphs(
    "CheckCircle",
    "checkmark.circle.fill",
    "yes present posted ready mapped match settled completed done succeeded finished",
  ),
  ...glyphs(
    "XCircle",
    "xmark.circle.fill",
    "no missing mismatch failed dispatch_failed dismissed deleted",
  ),
]);

function valueKey(value: string) {
  return value.toLowerCase().replace(/[\s-]+/g, "_");
}

function semanticColor(value: string): string | undefined {
  const key = valueKey(value);
  if (
    [
      "active",
      "available",
      "verified",
      "confirmed",
      "growing",
      "match",
      "matched",
      "present",
      "recorded",
      "posted",
      "completed",
      "done",
      "succeeded",
      "acquired",
      "yes",
      "mapped",
    ].includes(key)
  )
    return "var(--positive)";
  if (
    [
      "pending",
      "paused",
      "partial",
      "needs_review",
      "maybe",
      "ambiguous",
      "later",
      "bare",
      "waiting",
    ].includes(key) ||
    key.startsWith("pending_") ||
    key.startsWith("paused_")
  )
    return "var(--warning)";
  if (
    [
      "failed",
      "missing",
      "mismatch",
      "mismatched",
      "blocked",
      "void",
      "no",
    ].includes(key) ||
    key.endsWith("_failed") ||
    key.endsWith("_mismatch")
  )
    return "var(--destructive)";
  if (
    [
      "unknown",
      "unclassified",
      "unspecified",
      "unverified",
      "__none__",
      "none",
      "disabled",
      "finished",
      "not_expected",
      "not_applicable",
      "not_started",
      "unassigned",
      "other",
      "planned",
      "planning",
    ].includes(key)
  )
    return "var(--neutral-status)";
  if (["expected", "required", "running", "in_progress"].includes(key))
    return "var(--info)";
  return undefined;
}

type EnumOptionInput = {
  value: string;
  color?: string;
  role?: EnumRole | null;
  glyph?: EnumIcon;
};

/**
 * Complete once in declaration order, before any surface filters the choices.
 *
 * A roster is `status` when every option carries a condition color (declared
 * or inferred from its value); otherwise it is `category`. Category rosters
 * ignore the legacy blanket `slate` and cycle the category palette, so kinds
 * stay distinguishable. Re-running on completed options is a no-op.
 */
export function colorizeEnumOptions<T extends EnumOptionInput>(
  options: readonly T[],
  rosterRole?: EnumRole | null,
): Array<T & { color: string; role: EnumRole; glyph: EnumIcon }> {
  const explicit = options.map((option) =>
    option.color === undefined
      ? undefined
      : (LEGACY_COLORS.get(option.color) ?? option.color),
  );
  const slate = explicit.map((color) => color === "var(--slate)");
  // A legacy chart hue was picked for contrast, not meaning: a value that
  // names a state ("in_progress") takes that state's color instead.
  const semantic = options.map((option, index) => {
    if (slate[index]) return undefined;
    const declared = explicit[index];
    const legacyHue =
      option.color !== undefined &&
      declared?.startsWith("var(--category-") === true &&
      LEGACY_COLORS.has(option.color);
    return legacyHue
      ? (semanticColor(option.value) ?? declared)
      : (declared ?? semanticColor(option.value));
  });
  // Explicit slate is the neutral state inside a condition roster (a
  // reconciliation's explained difference) and noise anywhere else.
  const inferredRole: EnumRole =
    semantic.some((color) => color !== undefined) &&
    semantic.every(
      (color, index) =>
        slate[index] || (color !== undefined && CONDITION_COLORS.has(color)),
    )
      ? "status"
      : "category";
  const role = rosterRole ?? options[0]?.role ?? inferredRole;
  let index = 0;
  return options.map((option, position) => {
    const color =
      role === "status"
        ? (semantic[position] ?? "var(--neutral-status)")
        : (semantic[position] ??
          CATEGORY_COLORS[index++ % CATEGORY_COLORS.length]!);
    const glyph = option.glyph ??
      (role === "status"
        ? (VALUE_ICONS.get(valueKey(option.value)) ?? STATUS_ICONS.get(color))
        : (CATEGORY_ICONS.get(valueKey(option.value)) ??
          VALUE_ICONS.get(valueKey(option.value)) ??
          STATUS_ICONS.get(semanticColor(option.value) ?? ""))) ?? {
        phosphor: "Shapes",
        sfSymbol: "square.on.circle",
      };
    return { ...option, color, role, glyph };
  });
}
