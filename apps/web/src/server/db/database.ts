// Opaque type that prevents ALL method calls outside of repo layer
// This enforces that database access only happens in repo files
// Database has NO methods - it can only be passed around
declare const DatabaseBrand: unique symbol;
export interface Database {
  readonly [DatabaseBrand]: true;
}
