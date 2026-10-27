/**
 * Native schema names mapped to shared Swift codecs: schema name -> Swift type. The targets live in the `CubbyAPISupport` target
 * (`apps/apple/CubbyKit/Sources/CubbyAPISupport/`), each a single JSON
 * string on the wire, so every generated field typed by one of these
 * components is branded or calendar-typed at the boundary.
 */
export const TYPE_OVERRIDES = {
  Entity: "CubbyAPISupport.EntityKey",
  ImageShortcode: "CubbyAPISupport.ImageCode",
  InventoryShortcode: "CubbyAPISupport.InventoryEntryCode",
  LocationShortcode: "CubbyAPISupport.LocationCode",
  PlainDate: "CubbyAPISupport.PlainDate",
  ProductShortcode: "CubbyAPISupport.ProductCode",
  /**
   * Search hits name their entity by key but the roster of searchable
   * entities is not the catalog `EntityKey`; the native side reads the raw
   * string and drops hits whose kind it does not know.
   */
  SearchableEntity: "Swift.String",
} as const satisfies Record<string, string>;

/**
 * Kernel responses are untyped JSON objects, so no route reaches these record
 * schemas; hand-written Swift still decodes them by name from a kernel
 * detail or list row. Shared typed renderers also name their declared value
 * schemas here when kernel wire erasure otherwise makes them unreachable.
 * Remove record roots as views move onto the entity manifest.
 */
export const NATIVE_TYPED_RECORDS = [
  "ImageOut",
  "InventoryDetail",
  "LocationTreeNodeOut",
  "ProductDetail",
  "SpendingCategorySummary",
] as const;
