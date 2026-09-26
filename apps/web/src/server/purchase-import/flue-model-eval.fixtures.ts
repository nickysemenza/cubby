/**
 * Synthetic photo-inventory cases for the live coordinator model eval. Each
 * photo carries the analysis summary the agent reads (`get_photo_run_context`);
 * `expected` is the reviewer's answer key. Names and brands are invented.
 */
type EvalPhoto = {
  key: string;
  description: string;
  /** Label or OCR text the image description claims. */
  labelText?: string;
};

type EvalCatalogProduct = {
  key: string;
  name: string;
  manufacturer?: string;
};

export type ExpectedMatch =
  | { kind: "create" }
  | { kind: "existing"; product: string }
  /** Any outcome except attaching to one of these Products (wrong variants). */
  | { kind: "notExisting"; products: string[] };

export type EvalCase = {
  name: string;
  photos: EvalPhoto[];
  catalog: EvalCatalogProduct[];
  expected: { photos: string[]; match: ExpectedMatch }[];
};

const LARGE_BATCH_ITEMS = [
  ["canvas-tote", "canvas tote bag with navy handles", "Harbor Pack · Tote"],
  ["wool-beanie", "ribbed wool beanie, folded cuff", "Ridgeline · Merino"],
  [
    "rain-shell",
    "hooded rain shell jacket, zipped",
    "Fieldcraft · Storm Shell",
  ],
  [
    "chore-coat",
    "duck-canvas chore coat with corduroy collar",
    "Northwind Workwear · Chore Coat",
  ],
  ["work-gloves", "pair of leather work gloves", "Fieldcraft · Grip Glove"],
  [
    "flannel-shirt",
    "check flannel shirt with two chest pockets",
    "Northwind Workwear · Flannel",
  ],
  ["hiking-socks", "two pairs of wool hiking socks", "Ridgeline · Trail Sock"],
  ["belt", "leather belt with a brass buckle", "Lumen & Co · Harness Belt"],
] as const;
const LARGE_BATCH_COLORWAYS = [
  ["natural", "Natural", "M"],
  ["charcoal", "Charcoal", "L"],
  ["olive", "Olive", "S"],
  ["rust", "Rust", "XL"],
  ["navy", "Navy", "M"],
] as const;

/**
 * Items shot in order as item, label, and every other item a back view.
 * Neighbours differ in type; the same type recurs in other colourways, so
 * grouping must follow the label text, not the product type.
 */
function largeBatch(name: string, colorways: number): EvalCase {
  const photos: EvalPhoto[] = [];
  const expected: EvalCase["expected"] = [];
  let index = 0;
  for (const [colorKey, color, size] of LARGE_BATCH_COLORWAYS.slice(
    0,
    colorways,
  ))
    for (const [itemKey, description, label] of LARGE_BATCH_ITEMS) {
      const key = `${itemKey}-${colorKey}`;
      const group = [key, `${key}-label`];
      photos.push({ key, description: `${color} ${description}.` });
      photos.push({
        key: `${key}-label`,
        description: "Close-up of a sewn or printed tag.",
        labelText: `${label} · ${color} · ${size}`,
      });
      if (index % 2 === 0) {
        group.push(`${key}-back`);
        photos.push({
          key: `${key}-back`,
          description: `${color} ${description}. Back view.`,
        });
      }
      expected.push({ photos: group, match: { kind: "create" } });
      index += 1;
    }
  return { name, photos, catalog: [], expected };
}

export const flueModelEvalCases: EvalCase[] = [
  {
    name: "item-with-care-label",
    photos: [
      {
        key: "shirt",
        description:
          "A heather gray crew-neck t-shirt with short sleeves, laid flat, front view. No visible graphics.",
      },
      {
        key: "shirt-label",
        description:
          "Close-up of a woven neck label and a printed care tag inside a gray garment.",
        labelText: "Northwind Basics · 100% cotton · M · Machine wash cold",
      },
    ],
    catalog: [],
    expected: [{ photos: ["shirt", "shirt-label"], match: { kind: "create" } }],
  },
  {
    name: "similar-but-distinct",
    photos: [
      {
        key: "mug-blue",
        description:
          "White ceramic coffee mug, 12 oz, with a single thin blue stripe around the rim.",
      },
      {
        key: "mug-red",
        description:
          "White ceramic coffee mug, 12 oz, with a single thin red stripe around the rim.",
      },
    ],
    catalog: [],
    expected: [
      { photos: ["mug-blue"], match: { kind: "create" } },
      { photos: ["mug-red"], match: { kind: "create" } },
    ],
  },
  {
    name: "multi-angle-single-item",
    photos: [
      {
        key: "boots-front",
        description:
          "Pair of brown leather lace-up ankle boots, front three-quarter view.",
      },
      {
        key: "boots-side",
        description:
          "Brown leather lace-up ankle boot, side profile showing a stacked heel.",
      },
      {
        key: "boots-sole",
        description: "Rubber lug sole of a brown boot with a molded size mark.",
        labelText: "Fieldcraft · US 10",
      },
    ],
    catalog: [],
    expected: [
      {
        photos: ["boots-front", "boots-side", "boots-sole"],
        match: { kind: "create" },
      },
    ],
  },
  {
    name: "existing-product-match",
    photos: [
      {
        key: "sneaker",
        description:
          "Black running sneakers with orange laces and an orange heel tab.",
      },
      {
        key: "sneaker-tongue",
        description: "Tongue label of a black running sneaker.",
        labelText: "Trailmark Runner 2 · Black/Orange · US 9",
      },
    ],
    catalog: [
      {
        key: "runner-black",
        name: "Trailmark Runner 2 Black/Orange US 9",
        manufacturer: "Trailmark",
      },
      {
        key: "runner-blue",
        name: "Trailmark Runner 2 Blue/White US 9",
        manufacturer: "Trailmark",
      },
    ],
    expected: [
      {
        photos: ["sneaker", "sneaker-tongue"],
        match: { kind: "existing", product: "runner-black" },
      },
    ],
  },
  {
    name: "wrong-size-variant",
    photos: [
      {
        key: "fleece",
        description: "Navy full-zip fleece jacket with a stand collar.",
      },
      {
        key: "fleece-label",
        description: "Inner collar label of a navy fleece jacket.",
        labelText: "Ridgeline Fleece · Navy · S",
      },
    ],
    catalog: [
      {
        key: "fleece-large",
        name: "Ridgeline Fleece Jacket Navy L",
        manufacturer: "Ridgeline",
      },
    ],
    expected: [
      {
        photos: ["fleece", "fleece-label"],
        match: { kind: "notExisting", products: ["fleece-large"] },
      },
    ],
  },
  {
    name: "ambiguous-variant",
    photos: [
      {
        key: "vest",
        description: "Olive quilted vest with snap front.",
      },
      {
        key: "vest-label",
        description: "Faded neck label on an olive vest; size mark worn away.",
        labelText: "Northwind Workwear · Quilted Vest · Olive",
      },
    ],
    catalog: [
      {
        key: "vest-small",
        name: "Northwind Workwear Quilted Vest Olive S",
        manufacturer: "Northwind Workwear",
      },
      {
        key: "vest-large",
        name: "Northwind Workwear Quilted Vest Olive L",
        manufacturer: "Northwind Workwear",
      },
    ],
    expected: [
      {
        photos: ["vest", "vest-label"],
        match: { kind: "notExisting", products: ["vest-small", "vest-large"] },
      },
    ],
  },
  {
    // Regression: one item's unreadable size stopped the whole run, so the
    // two clear items were never proposed either.
    name: "ambiguous-item-among-clear-ones",
    photos: [
      {
        key: "boots",
        description: "A pair of worn tan leather work boots, laces tied.",
        labelText: "Bal / 7",
      },
      {
        key: "pants-waistband",
        description: "Close-up of a brown elastic waistband with a woven tag.",
        labelText: "Harbor Pack · REC.",
      },
      {
        key: "pants",
        description:
          "Brown wide-leg trousers with a black side stripe, laid flat.",
      },
      {
        key: "joggers-label",
        description: "Inside waistband of dark olive pants with a care tag.",
        labelText: "Ridgeline · Trail Jogger · Olive · 32",
      },
      {
        key: "joggers",
        description: "Dark olive tapered joggers laid flat.",
      },
    ],
    catalog: [
      {
        key: "boots-9-5",
        name: "Fieldcraft Pit Boot 6-inch Wheat 9.5 US",
        manufacturer: "Fieldcraft",
      },
      {
        key: "boots-10",
        name: "Fieldcraft Pit Boot 6-inch Wheat 10 US",
        manufacturer: "Fieldcraft",
      },
    ],
    expected: [
      {
        photos: ["boots"],
        match: { kind: "notExisting", products: ["boots-9-5", "boots-10"] },
      },
      { photos: ["pants-waistband", "pants"], match: { kind: "create" } },
      { photos: ["joggers-label", "joggers"], match: { kind: "create" } },
    ],
  },
  {
    name: "mixed-batch",
    photos: [
      {
        key: "lamp",
        description: "Brass desk lamp with a green glass shade, lit.",
      },
      {
        key: "lamp-base",
        description: "Underside of a brass lamp base with a sticker.",
        labelText: "Lumen & Co · Banker lamp · 60W max",
      },
      {
        key: "backpack",
        description: "Olive canvas backpack with brown leather straps.",
      },
      {
        key: "backpack-tag",
        description: "Sewn tag inside an olive canvas backpack.",
        labelText: "Harbor Pack · 22L",
      },
      {
        key: "book",
        description:
          "Hardcover book with a plain blue cloth cover, spine reads 'A Field Guide to Ferns'.",
      },
    ],
    catalog: [],
    expected: [
      { photos: ["lamp", "lamp-base"], match: { kind: "create" } },
      { photos: ["backpack", "backpack-tag"], match: { kind: "create" } },
      { photos: ["book"], match: { kind: "create" } },
    ],
  },
  largeBatch("large-batch", 1),
  // The native picker's maximum run size.
  largeBatch("hundred-photos", 5),
];
