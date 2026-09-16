/**
 * Generated schema types replaced by hand-written Swift types
 * (`typeOverrides.schemas` in swift-openapi-generator's config): component
 * name -> Swift type. The targets live in the `CubbyAPISupport` target
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
/** Modules the generated client imports for the overrides above. */
export const ADDITIONAL_IMPORTS: readonly string[] = ["CubbyAPISupport"];
