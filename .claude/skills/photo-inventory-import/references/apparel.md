# Apparel taxonomy

Root `Apparel`, three groups, each with existing types. Choose the closest
existing type; never create a new root, group, or type during import — an
unlisted item is a reported gap, not a taxonomy edit.

- **Shoes**: Sneakers, Boots, Sandals, Heels, Loafers, Dress shoes, Slippers.
- **Clothes**: Tops, Shirts, Pants, Shorts, Jackets, Skirts, Sweaters,
  Dresses, Vests, Activewear, Underwear, Socks, Sleepwear, Swimwear, Hoodies
  & sweatshirts.
- **Accessories**: Bags, Jewelry, Scarves, Sunglasses, Belts, Hats.

## Tag transcription

Transcribe every garment tag's printed facts verbatim into the Product
`notes` — brand line, size, fit (e.g. "Slim", "Relaxed"), fabric/material
composition, and country of origin — exactly as printed, not paraphrased or
normalized. This is separate from the Product `name`: the tag is evidence
retained for later reference, the name is the human-facing identity.

## Name and variant

Put size and color in the name: `Brand Model — Color, Size` (see
[product identity](../../product-enrichment/references/product-identity.md)).
One Product per exact variant — a different size or color is a different
Product, never a size/color field on a shared one. Identical copies of the
same exact variant (two shirts, same brand/model/color/size) are one Product
with an inventory quantity of 2, not two Products.

Shoes are pairs: a pair of shoes is quantity 1, never 2 — the left and right
shoe are not separate units, and a photo of both shoes is one item, not two.
