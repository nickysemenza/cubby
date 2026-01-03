# R2 Recipe Sync Design

Two-way sync for recipes between RecipeHub and Cloudflare R2, similar to the existing Google Sheets inventory sync.

## Goals

- **Backup & Portability** — Export recipes as human-readable files for backup, migration, or sharing
- **Cross-Device Sync** — Use R2 as a sync backend for offline-first or multi-instance scenarios
- All-or-nothing sync (no selective per-recipe sync for v1)

## Canonical Identifier

Recipes use **shortcodes** (e.g., `R-A3F2`) as the canonical sync identifier, not UUIDs:

- **UUID** = internal DB primary key (regenerated on fresh import)
- **Shortcode** = portable identifier that survives export/import

This means:
- R2 filenames use shortcode: `recipes/R-A3F2.md`
- Sync matching uses shortcode, not UUID
- Importing to a fresh database works (shortcode matches, new UUID assigned)

## Format

### Consolidate CompactRecipe → RecipeText

Replace the existing `CompactRecipe` TypeScript type with a unified `RecipeText` struct defined in Rust (ingredient-parser crate). This becomes the canonical format for:
- Recipe input (new recipe creation)
- Scraping/import
- R2 sync

### Rust Struct

```rust
pub struct RecipeText {
    pub shortcode: String,           // R-XXXX format, canonical identifier
    pub updated_at: Option<String>,
    pub name: String,
    pub url: Option<String>,
    pub sections: Vec<RecipeSection>,
}

pub struct RecipeSection {
    pub name: Option<String>,
    pub ingredients: Vec<String>,  // raw strings like "2 cups flour"
    pub instructions: Vec<String>,
}
```

### WASM Exports

```rust
pub fn parse_recipe_markdown(input: &str) -> RecipeText
pub fn serialize_recipe_markdown(recipe: &RecipeText) -> String
```

### Markdown Format

**Simple recipe (no sections):**
```markdown
---
shortcode: R-A3F2
updatedAt: 2025-01-15T10:25:00Z
url: https://example.com/pancakes
---

# Pancakes

- 1 cup flour
- 1 cup milk
- 1 egg

1. Mix ingredients
2. Cook on griddle
```

**Multi-section recipe:**
```markdown
---
shortcode: R-X7K9
updatedAt: 2025-01-15T10:25:00Z
---

# Breakfast Tacos

## Eggs
- 2 eggs
- 1 tsp oil

1. scramble eggs with salt and pepper

## Assembly
- 1 tortilla

1. heat tortillas in pan
2. fill with eggs

## Toppings
- 1 tbsp salsa
- 1 tbsp cilantro

1. top with salsa and cilantro
```

### Parsing Rules

- `---` delimiters = YAML frontmatter (shortcode, updatedAt, url)
- `# ` = recipe title
- `## ` = section name (if present, multi-section mode)
- `- ` = ingredient line
- `1. `, `2. `, etc. = instruction line
- No `## ` headers = single implicit section

## Storage

### R2 Structure

```
{R2_KEY_PREFIX}/recipes/{shortcode}.md
```

Example: `recipes/R-A3F2.md`

Uses the existing R2 bucket (same as images), with a `recipes/` prefix. The filename **is** the shortcode, making files easy to browse and identify.

### Org Metadata

```typescript
{
  r2RecipeSyncEnabled: boolean,
  r2RecipeLastSync: string | null  // ISO timestamp
}
```

## Sync Logic

### Push Flow (App → R2)

1. User clicks "Push"
2. Preview phase:
   - List all local recipes (with shortcodes)
   - List all R2 files (shortcode = filename)
   - Compare by shortcode:
     - Local only → **Add** (new file to R2)
     - Both, local newer → **Update**
     - Both, R2 newer → **Conflict**
     - R2 only → **Remove** (delete from R2)
     - Same updatedAt → **Skip**
3. Show preview dialog with changes
4. User confirms → write/delete files in R2

### Pull Flow (R2 → App)

1. User clicks "Pull"
2. Preview phase:
   - List all R2 files (parse shortcode from filename)
   - List all local recipes
   - Compare by shortcode:
     - R2 only → **Create** (new recipe with matching shortcode)
     - Both, R2 newer → **Update**
     - Both, local newer → **Conflict**
     - Local only → **Remove** (delete from app)
     - Same updatedAt → **Skip**
3. Show preview dialog with changes
4. User confirms → upsert/delete recipes in DB

### Conflict Resolution

When the same recipe was modified on both sides since last sync, show both versions and let user choose:
- **Keep Local** — overwrite R2 with local version
- **Keep R2** — overwrite local with R2 version
- **Skip** — leave both unchanged, resolve later

## API Design

### tRPC Router: `r2RecipeSyncRouter`

```typescript
getConnectionStatus: () => {
  configured: boolean,   // R2 env vars present
  enabled: boolean,      // org has enabled sync
  lastSync: string | null,
}

updateSyncEnabled: (enabled: boolean) => void

previewPush: () => RecipeSyncResult
pushToR2: () => { pushed: number, deleted: number }

previewPull: () => RecipeSyncResult
applyPull: () => RecipeSyncResult

resolveConflict: (shortcode, resolution: "keep_local" | "keep_r2" | "skip") => void
```

### Schemas

```typescript
const recipeSyncResultItem = z.object({
  shortcode: z.string(),  // R-XXXX format
  recipeName: z.string(),
  action: z.enum(["create", "update", "remove", "skip", "conflict"]),
  localUpdatedAt: z.string().nullable(),
  r2UpdatedAt: z.string().nullable(),
});

const recipeSyncResult = z.object({
  created: z.number(),
  updated: z.number(),
  removed: z.number(),
  skipped: z.number(),
  conflicts: z.number(),
  items: z.array(recipeSyncResultItem),
});
```

## UI

### Recipe List Page

Add sync buttons alongside existing actions:
```
[↑ Push] [↓ Pull]
```

### Preview Dialog

Reuse pattern from `google-sheets-sync.tsx`:
- Summary cards: Created, Updated, Removed, Skipped, Conflicts
- Table with recipe name, action, timestamps
- Conflict rows expandable to show diff
- Apply / Cancel buttons

### Settings Page

Add to `/settings/integrations`:
- Toggle: "Sync recipes to R2"
- Last sync timestamp display
- Manual push/pull buttons

## Implementation Plan

### Phase 1: Rust (ingredient-parser)

1. Add `RecipeText` and `RecipeSection` structs to `src/recipe.rs`
2. Implement `parse_recipe_markdown()` in `src/recipe_markdown.rs`
3. Implement `serialize_recipe_markdown()` in same file
4. Add WASM bindings in `src/lib.rs`
5. Write roundtrip tests

### Phase 2: TypeScript Migration

1. Rebuild recipebridge WASM package
2. Delete `compactRecipeSchema` and `CompactRecipe` from `codec/codec.ts`
3. Update `parseCompactRecipe()` in `codec/parser.ts` to use WASM
4. Update all usages: scraper, seed data, tests

### Phase 3: R2 Sync Infrastructure

1. Create `server/utils/r2-recipes.ts`:
   - `listRecipeFiles()` — returns shortcodes from filenames
   - `getRecipeFile(shortcode)`
   - `putRecipeFile(recipe)` — uses shortcode for filename
   - `deleteRecipeFile(shortcode)`

2. Create `server/repo/recipe-sync.ts`:
   - `compareForPush(localRecipes, r2Files)`
   - `compareForPull(r2Files, localRecipes)`

3. Create `server/repo/recipe-export.ts`:
   - `recipeOutToRecipeText(recipe)` — DB recipe → RecipeText
   - `formatIngredientLine(amounts, ingredientName)` — → "2 cups flour"

### Phase 4: tRPC & UI

1. Create `server/api/routers/r2-recipe-sync.ts` with all endpoints
2. Create `schemas/recipe-sync.ts` with result schemas
3. Create `app/_components/recipe/r2-recipe-sync.tsx` component
4. Update `settings/integrations/page.tsx` with R2 sync config
5. Add sync buttons to recipe list page

## Future Considerations

- Selective sync (per-recipe opt-in)
- Version history (keep previous versions in R2)
- Auto-sync on save
- Periodic background sync
