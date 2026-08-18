/**
 * Compatibility entrypoint for Problem filter semantics.
 *
 * Declarations live in `filter-search-fields.ts`, the dependency-light
 * semantic registry that also generates route search fields. Keeping this
 * focused import path avoids reintroducing a second filter projection.
 */
export {
  compileProblemFilters,
  problemFilterSemantics as problemFilterSpecs,
} from "./filter-search-fields";
