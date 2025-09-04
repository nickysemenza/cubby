## General Guidelines

- read the readme.md to understand project structure
- after touching files, format them with prettier
- ensure the typechecker and linter is happy with all changes (npm run check)
- todos are kept in @docs/todos.md
- helper functions should not be added without being used

## Type Safety & Schema Patterns

- whenever possible, types should be derived from common zod schemas
- import existing types instead of redefining or casting them
- avoid using `any` type - use proper typing with generics, unions, or specific types instead
- do not add @typescript-eslint/no-explicit-any disable comments - fix the typing instead

## Architecture Patterns

- follow the layered architecture: schemas -> repos -> routers -> components
- maintain entity-based organization (recipes, products, ingredients, locations, etc.)
- since many of the forms / routers / repos / etc are the same between entities (recipes, locations, products, etc), try to use common helper functions as much as possible
- use common helper functions across similar entities instead of duplicating logic

## Form Patterns

- use FormWrapper component for consistent form layout with submit/cancel buttons
- use mode-based props: CreateModeProps and EditModeProps for forms
- use common field components: UnifiedTextField, ComboboxField, SelectField, etc.
- for dynamic arrays, use ArrayFieldManager component
- use buildUpdateObject helper to detect changed fields in edit forms
- use detectComboboxIdChange helper for combobox field updates

## Database & API Patterns

- extend baseEntitySchema for entities with id, name, and timestamps
- use extractDbTimestampsFromDBRec helper for timestamp fields
- use formatSearchTerm helper for consistent database searches
- use sortPaginationCombo schema and buildPaginatedResponse for paginated endpoints
- follow tRPC patterns with input/output schemas and publicProcedure

## Testing Patterns

- unit tests: .unit.test.ts suffix
- integration tests: .integration.test.ts suffix
- e2e tests: in /tests/e2e directory
- test common utilities like cn() function for class merging

## UI/UX Patterns

- use cn() utility for merging Tailwind classes with conflict resolution
- use lucide-react icons consistently
- use SideBySideFields component for two-column form layouts
- follow shadcn/ui component patterns in src/components/ui
- use class-variance-authority (CVA) for component variants when there are multiple styling options
