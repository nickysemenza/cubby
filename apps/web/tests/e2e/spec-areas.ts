/**
 * Maps every E2E spec file to the source globs it exercises, so
 * `scripts/e2e-affected.ts` can select only the specs a change affects for
 * fast local iteration (see `pnpm --dir apps/web test:e2e:affected`).
 *
 * Derivation for each spec: the routes it navigates to (mapped to
 * `src/routes/<route>*` and the feature dirs under `src/app/<feature>/**` /
 * `src/app/_components/<area>/**` those routes render), the entities its
 * fixtures seed (mapped to `src/server/repo/<entity>/**` and related
 * server-side files), and shared contract files it imports.
 *
 * Every glob is relative to the repository root (matching `git diff
 * --name-only` output), e.g. `apps/web/src/routes/__root.tsx`.
 *
 * Keep this file honest: `spec-areas.unit.test.ts` asserts every
 * `tests/e2e/*.spec.ts` file on disk has an entry here, and that no entry
 * points at a spec file that doesn't exist. When you add a spec, add its
 * entry; when a spec's routes or fixtures change, update its globs. When
 * unsure, prefer a broader glob (or ALL_SPECS_TRIGGERS) over missing one --
 * the affected script fails safe to "run everything" for anything it can't
 * place, but a stale narrow entry silently skips a spec that should run.
 */

const WEB = "apps/web";

/**
 * Shared seams: a change to any of these selects every spec, because they
 * are load-bearing for the whole suite (test harness plumbing) or are the
 * generic foundation nearly every route/spec renders through (the entity
 * kernel, the entity display/editing spine, and the app shell).
 */
export const ALL_SPECS_TRIGGERS: readonly string[] = [
  `${WEB}/tests/e2e/e2e-*.ts`,
  `${WEB}/tests/e2e/harness-services/**`,
  `${WEB}/tests/e2e/dnd-helpers.ts`,
  `${WEB}/playwright.config.ts`,
  `${WEB}/src/routes/__root.tsx`,
  `${WEB}/src/routes/_authenticated.tsx`,
  // App shell / global navigation, rendered on every authenticated page.
  `${WEB}/src/app/_components/navigation/**`,
  `${WEB}/src/app/_components/navbar/**`,
  // The generic entity kernel (server) and its browser-side counterpart
  // (list/detail/editing/filters/manifest) that most routes render through.
  `${WEB}/src/server/entity-kernel/**`,
  `${WEB}/src/entities/**`,
  `${WEB}/src/app/_components/entity-list/**`,
  `${WEB}/src/app/_components/entity-detail/**`,
  `${WEB}/src/app/_components/actions/**`,
  `${WEB}/src/app/_components/table/**`,
  `${WEB}/src/app/_components/forms/**`,
  `${WEB}/src/app/_components/form-fields.ts`,
  `${WEB}/src/app/_components/form-utils*.ts*`,
  `${WEB}/src/app/_components/combobox/**`,
  `${WEB}/src/app/_components/merge/**`,
  `${WEB}/src/app/_components/relatedness/**`,
  `${WEB}/src/app/_components/relationships/**`,
  `${WEB}/src/app/_components/entity-media/**`,
  `${WEB}/src/app/_components/entity-workbench-inspector.tsx`,
  `${WEB}/src/app/_components/inspector-frame.tsx`,
  `${WEB}/src/server/db/**`,
  `${WEB}/src/server.ts`,
  `${WEB}/src/cf-server.ts`,
  `${WEB}/src/integrations/tanstack-query/start-transport.ts`,
  `${WEB}/src/integrations/tanstack-query/browser-operation-transport.ts`,
  `${WEB}/src/server/browser-operation-dispatch.ts`,
  `${WEB}/src/server/start-operation-dispatch.server.ts`,
  `${WEB}/vite.config.ts`,
  `${WEB}/package.json`,
  "pnpm-lock.yaml",
  "packages/**",
];

export interface SpecAreaEntry {
  /** Spec file path relative to `apps/web/tests/e2e/`. */
  file: string;
  /** Repo-root-relative globs whose change should select this spec. */
  globs: readonly string[];
}

export const SPEC_AREAS: readonly SpecAreaEntry[] = [
  {
    file: "activity.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/activity.tsx`,
      `${WEB}/src/routes/_authenticated/activities.tsx`,
      `${WEB}/src/app/activity/**`,
      `${WEB}/src/server/repo/activity.ts`,
      `${WEB}/src/server/repo/activity-input.ts`,
    ],
  },
  {
    file: "browser-operation-dispatch.spec.ts",
    globs: [
      `${WEB}/src/lib/browser-operation-path.ts`,
      `${WEB}/src/lib/superjson-wire.ts`,
      `${WEB}/src/server/start-operation-dispatch.contract.ts`,
      `${WEB}/src/server/start-operation.contract.ts`,
      `${WEB}/src/server/workflows/audit-log.ts`,
      `${WEB}/src/server/repo/vendor.ts`,
    ],
  },
  {
    file: "bulk-edit.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/tasks.index.tsx`,
      `${WEB}/src/routes/_authenticated/plantings.index.tsx`,
      `${WEB}/src/app/tasks/**`,
      `${WEB}/src/server/repo/task/**`,
      `${WEB}/src/server/repo/garden/**`,
    ],
  },
  {
    file: "calendar.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/calendar.tsx`,
      `${WEB}/src/app/calendar/**`,
      `${WEB}/src/server/repo/calendar.ts`,
      `${WEB}/src/server/repo/calendar-caldav.ts`,
      `${WEB}/src/server/repo/calendar-plantings.ts`,
      `${WEB}/src/server/repo/task/**`,
    ],
  },
  {
    file: "console-ledger-overhaul.spec.ts",
    globs: [
      `${WEB}/src/routes/index.tsx`,
      `${WEB}/src/app/_components/home/**`,
    ],
  },
  {
    file: "cookbook-photos.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/cookbooks.$shortcode.tsx`,
      `${WEB}/src/routes/_authenticated/cookbooks.index.tsx`,
      `${WEB}/src/routes/_authenticated/recipes.import.tsx`,
      `${WEB}/src/routes/_authenticated/recipes.$shortcode.tsx`,
      `${WEB}/src/app/cookbooks/**`,
      `${WEB}/src/app/recipes/**`,
      `${WEB}/src/app/images/**`,
      `${WEB}/src/server/repo/cookbook.ts`,
      `${WEB}/src/server/repo/recipe/**`,
      `${WEB}/src/server/repo/image.ts`,
      `${WEB}/src/server/repo/import-recipe-convert.ts`,
      `${WEB}/src/entities/cookbook.functions.ts`,
    ],
  },
  {
    file: "create-recipe-full-flow.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/recipes.new.tsx`,
      `${WEB}/src/routes/_authenticated/recipes.$shortcode.tsx`,
      `${WEB}/src/app/recipes/**`,
      `${WEB}/src/server/repo/recipe/**`,
      `${WEB}/src/server/repo/ingredient/**`,
    ],
  },
  {
    file: "recipe-flow.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/recipes.new.tsx`,
      `${WEB}/src/app/recipes/**`,
      `${WEB}/src/server/repo/recipe/**`,
      `${WEB}/src/server/ai/features.ts`,
      `${WEB}/src/server/ai/**`,
      `${WEB}/tests/e2e/build-constants.ts`,
    ],
  },
  {
    file: "declared-record-lists.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/purchases.index.tsx`,
      `${WEB}/src/routes/_authenticated/purchases.$shortcode.tsx`,
      `${WEB}/src/routes/_authenticated/expenses.index.tsx`,
      `${WEB}/src/routes/_authenticated/locations.index.tsx`,
      `${WEB}/src/app/purchases/**`,
      `${WEB}/src/app/expenses/**`,
      `${WEB}/src/app/locations/**`,
      `${WEB}/src/server/repo/purchase.ts`,
      `${WEB}/src/server/repo/expense/**`,
      `${WEB}/src/server/repo/location/**`,
    ],
  },
  {
    file: "dnd-interactions.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/tasks.index.tsx`,
      `${WEB}/src/app/tasks/**`,
      `${WEB}/src/server/repo/task/**`,
    ],
  },
  {
    file: "enrichment-workflow.spec.ts",
    globs: [
      `${WEB}/src/routes/api/workflow-stream/**`,
      `${WEB}/src/app/ingredients/**`,
      `${WEB}/src/server/repo/ingredient/**`,
    ],
  },
  {
    file: "entity-card-layout.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/products.index.tsx`,
      `${WEB}/src/routes/_authenticated/cookbooks.index.tsx`,
      `${WEB}/src/app/products/**`,
      `${WEB}/src/app/cookbooks/**`,
      `${WEB}/src/server/repo/product/**`,
      `${WEB}/src/server/repo/cookbook.ts`,
    ],
  },
  {
    file: "entity-dependency-graph.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/entities.tsx`,
      `${WEB}/src/routes/_authenticated/graph.tsx`,
      `${WEB}/src/routes/_authenticated/recipes.new.tsx`,
      `${WEB}/src/routes/_authenticated/products.$shortcode.tsx`,
      `${WEB}/src/server/repo/entity-graph.ts`,
      `${WEB}/src/server/repo/entity-graph-explore.ts`,
      `${WEB}/src/server/repo/entity-graph-paths.ts`,
      `${WEB}/src/server/repo/entity-graph-path-search.ts`,
    ],
  },
  {
    file: "entity-editor-lifecycle.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/vendors.$shortcode.tsx`,
      `${WEB}/src/app/vendors/**`,
      `${WEB}/src/server/repo/vendor.ts`,
      `${WEB}/src/server/repo/vendor.entity-adapter.ts`,
    ],
  },
  {
    file: "garden.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/plantings.$shortcode.tsx`,
      `${WEB}/src/routes/_authenticated/plantings.index.tsx`,
      `${WEB}/src/routes/_authenticated/garden-entries.$shortcode.tsx`,
      `${WEB}/src/routes/_authenticated/garden-entries.index.tsx`,
      `${WEB}/src/routes/_authenticated/locations.$shortcode.tsx`,
      `${WEB}/src/app/locations/**`,
      `${WEB}/src/app/ingredients/**`,
      `${WEB}/src/server/repo/garden/**`,
      `${WEB}/src/server/repo/calendar-plantings.ts`,
      `${WEB}/src/server/repo/location/**`,
      `${WEB}/src/server/repo/ingredient/**`,
      `${WEB}/src/server/garden-guides/**`,
    ],
  },
  {
    file: "http-api.spec.ts",
    globs: [
      `${WEB}/src/routes/api/v1/**`,
      `${WEB}/src/routes/api/auth/**`,
      `${WEB}/src/routes/_authenticated/account.$accountView.tsx`,
      `${WEB}/src/lib/http-api/**`,
      `${WEB}/src/server/repo/vendor.ts`,
    ],
  },
  {
    file: "http-resource-api.spec.ts",
    globs: [
      `${WEB}/src/routes/api/v1/**`,
      `${WEB}/src/routes/api/auth/**`,
      `${WEB}/src/lib/http-api/**`,
    ],
  },
  {
    file: "inheritance.spec.ts",
    globs: [
      `${WEB}/tests/e2e/inheritance-contract.ts`,
      `${WEB}/src/server/repo/task-inheritance.ts`,
      `${WEB}/src/server/repo/purchase-inheritance.ts`,
      `${WEB}/src/server/repo/expense-inheritance.ts`,
      `${WEB}/src/server/repo/calendar-inheritance.integration.test.ts`,
      `${WEB}/src/server/repo/inheritance-validation.ts`,
    ],
  },
  {
    file: "inspect-contract.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/products.index.tsx`,
      `${WEB}/src/app/products/**`,
      `${WEB}/src/server/repo/product/**`,
    ],
  },
  {
    file: "inventory-session.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/inventory.session.tsx`,
      `${WEB}/src/routes/_authenticated/inventory.index.tsx`,
      `${WEB}/src/routes/_authenticated/inventory.$shortcode.tsx`,
      `${WEB}/src/app/inventory/**`,
      `${WEB}/src/server/repo/inventory/**`,
    ],
  },
  {
    file: "meal-nutrition.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/meals.$shortcode.tsx`,
      `${WEB}/src/app/meals/**`,
      `${WEB}/src/app/_components/nutrition/**`,
      `${WEB}/src/server/repo/meal/**`,
      `${WEB}/src/server/services/meal-nutrition.service.ts`,
      `${WEB}/src/lib/meal-food-nutrition.ts`,
    ],
  },
  {
    file: "nutrition.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/recipes.$shortcode.tsx`,
      `${WEB}/src/app/recipes/**`,
      `${WEB}/src/app/_components/nutrition/**`,
      `${WEB}/src/server/repo/recipe/**`,
      `${WEB}/src/server/services/recipe-costing.service.ts`,
      `${WEB}/src/lib/nutrition-estimates.ts`,
      `${WEB}/src/lib/nutrition-format.ts`,
      `${WEB}/src/lib/nutrition-intel.ts`,
    ],
  },
  {
    file: "pantry-staples.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/ingredients.$shortcode.tsx`,
      `${WEB}/src/routes/_authenticated/meals.suggestions.tsx`,
      `${WEB}/src/routes/_authenticated/meals.shopping-list.tsx`,
      `${WEB}/src/routes/_authenticated/pantry-view.tsx`,
      `${WEB}/src/app/ingredients/**`,
      `${WEB}/src/app/meals/**`,
      `${WEB}/src/app/pantry-view/**`,
      `${WEB}/src/server/repo/ingredient/**`,
      `${WEB}/src/server/repo/meal/**`,
    ],
  },
  {
    file: "performance.spec.ts",
    globs: [
      `${WEB}/src/routes/index.tsx`,
      `${WEB}/src/routes/_authenticated/locations.index.tsx`,
      `${WEB}/src/app/_components/home/**`,
      `${WEB}/src/app/locations/**`,
    ],
  },
  {
    file: "photo-group-review.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/runs.$shortcode.tsx`,
      `${WEB}/src/routes/_authenticated/runs.index.tsx`,
      `${WEB}/src/app/import-runs/**`,
      `${WEB}/src/app/images/**`,
      `${WEB}/src/server/repo/import-run.ts`,
      `${WEB}/src/server/repo/image-sighting.ts`,
      `${WEB}/src/server/repo/photo-import.ts`,
      `${WEB}/src/server/services/photo-import-stage.service.ts`,
      `${WEB}/src/server/services/photo-import-finalize.service.ts`,
      `${WEB}/src/server/services/photo-import-reconcile.service.ts`,
    ],
  },
  {
    file: "product-bulk-workflow.spec.ts",
    globs: [
      `${WEB}/src/routes/api/workflow-stream/**`,
      `${WEB}/src/routes/_authenticated/products.index.tsx`,
      `${WEB}/src/app/products/**`,
      `${WEB}/src/server/repo/product/**`,
    ],
  },
  {
    file: "product-photo-first.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/products.index.tsx`,
      `${WEB}/src/routes/_authenticated/products.$shortcode.tsx`,
      `${WEB}/src/app/products/**`,
      `${WEB}/src/app/_components/PendingImageUpload.tsx`,
      `${WEB}/src/app/_components/entity-media/**`,
      `${WEB}/src/server/repo/product/**`,
      `${WEB}/src/server/repo/image.ts`,
      `${WEB}/src/server/services/image-storage.service.ts`,
      `${WEB}/src/lib/image.functions.ts`,
    ],
  },
  {
    file: "product-ssr.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/products.$shortcode.tsx`,
      `${WEB}/src/app/products/**`,
      `${WEB}/src/server/repo/product/**`,
    ],
  },
  {
    file: "project-tracker.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/projects.$shortcode.tsx`,
      `${WEB}/src/routes/_authenticated/projects.index.tsx`,
      `${WEB}/src/routes/_authenticated/tasks.index.tsx`,
      `${WEB}/src/app/projects/**`,
      `${WEB}/src/app/tasks/**`,
      `${WEB}/src/server/repo/project/**`,
      `${WEB}/src/server/repo/task/**`,
      `${WEB}/src/app/_components/command-menu.tsx`,
      `${WEB}/src/app/_components/command-menu-loader.ts`,
      `${WEB}/src/app/_components/command-menu-search-groups.unit.test.tsx`,
    ],
  },
  {
    file: "relationship-discovery.spec.ts",
    globs: [
      `${WEB}/tests/e2e/relationship-discovery-contract.ts`,
      `${WEB}/src/routes/_authenticated/purchases.$shortcode.tsx`,
      `${WEB}/src/routes/_authenticated/tasks.index.tsx`,
      `${WEB}/src/routes/_authenticated/plantings.index.tsx`,
      `${WEB}/src/server/repo/relatedness/**`,
      `${WEB}/src/server/repo/merge/**`,
      `${WEB}/src/server/repo/relation-mutation-adapter.ts`,
      `${WEB}/src/server/repo/relation-preflight.ts`,
      `${WEB}/src/server/services/relatedness.service.ts`,
      `${WEB}/src/server/services/relatedness-ledger.ts`,
      `${WEB}/src/server/services/placement-recommendation.service.ts`,
    ],
  },
  {
    file: "connected-records.spec.ts",
    globs: [
      `${WEB}/tests/e2e/connected-records-contract.ts`,
      `${WEB}/src/routes/_authenticated/plants.$shortcode.tsx`,
      `${WEB}/src/routes/_authenticated/connections.tsx`,
      `${WEB}/src/server/repo/connected-records.ts`,
      `${WEB}/src/server/repo/relatedness/**`,
    ],
  },
  {
    file: "shortcode-routes.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/$shortcode.tsx`,
      `${WEB}/src/routes/_authenticated/locations.$shortcode.tsx`,
      `${WEB}/src/server/repo/shortcode-resolver.ts`,
      `${WEB}/src/server/repo/shortcode-tables.ts`,
      `${WEB}/src/server/repo/shortcode-utils.ts`,
    ],
  },
  {
    file: "start-entity-transport.spec.ts",
    globs: [`${WEB}/src/server/entity-kernel/**`],
  },
  {
    file: "statement-import.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/statement-rows.import.tsx`,
      `${WEB}/src/app/finance/statement-csv.ts`,
      `${WEB}/src/server/repo/statement-row.ts`,
      `${WEB}/src/server/repo/financial-transaction.ts`,
      `${WEB}/src/server/workflows/statement-row.server.ts`,
    ],
  },
  {
    file: "tools-flow.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/projects.tools.tsx`,
      `${WEB}/src/app/tools/**`,
      `${WEB}/src/app/projects/**`,
      `${WEB}/src/server/repo/project-tools.integration.test.ts`,
      `${WEB}/src/server/repo/product/**`,
    ],
  },
  {
    file: "unauth.pages.spec.ts",
    globs: [
      `${WEB}/src/routes/index.tsx`,
      `${WEB}/src/routes/auth.$authView.tsx`,
      `${WEB}/src/routes/_authenticated/products.$shortcode.tsx`,
      `${WEB}/src/app/auth/**`,
      `${WEB}/src/app/_components/home/**`,
      `${WEB}/src/app/_components/footer.tsx`,
    ],
  },
  {
    file: "unknown-expense-dates.spec.ts",
    globs: [
      `${WEB}/tests/e2e/unknown-expense-date-flow.ts`,
      `${WEB}/src/app/expenses/**`,
      `${WEB}/src/server/repo/expense/**`,
      `${WEB}/src/server/repo/expense-attribution.ts`,
    ],
  },
  {
    file: "wardrobe-preparation.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/products.index.tsx`,
      `${WEB}/src/routes/_authenticated/collections.wardrobe.$owner.tsx`,
      `${WEB}/src/app/products/**`,
      `${WEB}/src/app/collections/**`,
      `${WEB}/src/server/repo/product-category.ts`,
      `${WEB}/src/server/repo/product/**`,
    ],
  },
  {
    file: "wardrobe-owner.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/collections.wardrobe.$owner.tsx`,
      `${WEB}/src/routes/_authenticated/inventory.$shortcode.tsx`,
      `${WEB}/src/app/collections/**`,
      `${WEB}/src/app/inventory/**`,
      `${WEB}/src/server/repo/inventory/**`,
      `${WEB}/src/server/repo/smart-collection-membership.ts`,
    ],
  },
  {
    file: "browser-workflows.spec.ts",
    globs: [
      `${WEB}/src/routes/_authenticated/recommendations.workbench.tsx`,
      `${WEB}/src/app/recommendations/**`,
      `${WEB}/src/routes/_authenticated/search.index.tsx`,
      `${WEB}/src/routes/_authenticated/locations.index.tsx`,
      `${WEB}/src/routes/_authenticated/products.index.tsx`,
      `${WEB}/src/routes/_authenticated/recipes*`,
      `${WEB}/src/routes/_authenticated/expenses*`,
      `${WEB}/src/routes/_authenticated/meals.shopping-list.tsx`,
      `${WEB}/src/app/_components/search/**`,
      `${WEB}/src/app/locations/**`,
      `${WEB}/src/app/products/**`,
      `${WEB}/src/app/recipes/**`,
      `${WEB}/src/app/expenses/**`,
      `${WEB}/src/app/meals/**`,
      `${WEB}/src/server/repo/location/**`,
      `${WEB}/src/server/repo/product/**`,
      `${WEB}/src/server/repo/expense/**`,
      `${WEB}/src/server/repo/meal/**`,
    ],
  },
];
