# Remove Google Sheets Sync Integration

**Status:** Ready to execute

## Why

The Google Sheets integration is a bidirectional sync system (~20+ files) originally built for two purposes:

1. **Backup** — exporting data to sheets as a safety net
2. **Dev/prod data sync** — copying data between environments

Neither purpose is needed anymore. The app runs on Neon (managed Postgres), which provides automatic backups and database branching for dev/prod parity. The sync code is pure dead weight — unused complexity that still costs maintenance attention (it has 3 open P1 todos for bugs that will never matter).

## Files to Delete

### Core sync logic
- `apps/web/src/server/api/routers/google-sheets.ts` — tRPC router (1,823 lines)
- `apps/web/src/server/clients/google-sheets.ts` — Google Sheets API client
- `apps/web/src/server/repo/sync/` — entire directory (comparison, snapshot, config, tests)
- `apps/web/src/schemas/sync.ts` — sync Zod schemas

### UI
- `apps/web/src/app/_components/sync/` — entire directory (dialog, badge, hook, tests)
- `apps/web/src/app/settings/integrations/` — entire directory (integrations-page.tsx)
- `apps/web/src/routes/settings.integrations.tsx` — route file
- `apps/web/src/routes/settings.integrations.debug.tsx` — debug route file

### Todos (sync-specific bugs)
- `todos/001-pending-p1-race-condition-preview-apply-sync.md`
- `todos/002-pending-p1-no-transaction-wrapper-sync.md`
- `todos/003-pending-p1-n-plus-1-csv-import.md`

## Files to Modify

### `apps/web/src/server/api/root.ts`
- Remove `import { googleSheetsRouter } from "./routers/google-sheets";`
- Remove `googleSheets: googleSheetsRouter,` from the router object

### `apps/web/src/app/_components/MainNav.tsx`
- Remove `import { SyncStatusBadge } from "./sync/sync-status-badge";`
- Remove `<SyncStatusBadge />` and its wrapping `<div>` (the `ProblemsBadge` can stand alone without the flex wrapper)

### `apps/web/src/app/_components/navbar/user-avatar-dropdown.tsx`
- Remove the Settings menu item linking to `/settings/integrations` (there are no other settings pages; Account already has its own link)
- Remove the now-unused `Settings` import from lucide-react

### `apps/web/src/app/_components/navigation/nav-items.ts`
- Remove `Plug` from lucide imports
- Remove the `integrations` nav item definition
- Remove `integrations` from the `moreNavItems` array
- Remove `integrations` from the `desktopMoreItems` array

### `apps/web/package.json`
- Remove `"googleapis": "^171.3.0"` from dependencies

### `apps/web/.env.example`
- Remove the Google Sheets env var section (the `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` comment block)

## Post-change Steps

1. `pnpm install` — update lockfile after removing googleapis
2. `pnpm run format:write` — format changed files
3. `pnpm run typecheck` — verify no type errors
4. TanStack Router will auto-regenerate `routeTree.gen.ts` when the route files are deleted
5. Grep for any remaining references: `googleSheets`, `sync-dialog`, `SyncStatusBadge`, `googleapis`, `google-sheets`
