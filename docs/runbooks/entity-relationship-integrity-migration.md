# Entity relationship integrity migration

Use one exclusive production migration owner. Application code in this PR is
compatible before and after these constraints exist; deploy it before applying
the DDL.

## 1. Blocking audit

Run against the production `DATABASE_URL`:

```bash
pnpm --dir apps/web db:preflight-entity-integrity
```

Any non-zero result blocks migration. Inspect and repair the named family
explicitly. Do not heuristically reparent Locations or delete dependency edges.

## 2. Apply constraints

Apply deliberately; ordinary `drizzle-kit push` does not reliably add CHECK
constraints to existing tables.

```sql
ALTER TABLE "Location"
  ADD CONSTRAINT "Location_parentId_Location_id_fk"
  FOREIGN KEY ("parentId") REFERENCES "Location"("id") NOT VALID;

ALTER TABLE "Location"
  ADD CONSTRAINT "Location_productId_type_check"
  CHECK ("productId" IS NULL OR "type" IS NULL) NOT VALID;

ALTER TABLE "ProjectDependency"
  ADD CONSTRAINT "ProjectDependency_no_self_check"
  CHECK ("projectId" <> "blockedByProjectId") NOT VALID;

ALTER TABLE "TaskDependency"
  ADD CONSTRAINT "TaskDependency_no_self_check"
  CHECK ("taskId" <> "blockedByTaskId") NOT VALID;

ALTER TABLE "Location"
  VALIDATE CONSTRAINT "Location_parentId_Location_id_fk";
ALTER TABLE "Location"
  VALIDATE CONSTRAINT "Location_productId_type_check";
ALTER TABLE "ProjectDependency"
  VALIDATE CONSTRAINT "ProjectDependency_no_self_check";
ALTER TABLE "TaskDependency"
  VALIDATE CONSTRAINT "TaskDependency_no_self_check";
```

If a constraint already exists, inspect its definition and skip that one rather
than dropping it reflexively.

## 3. Read back

```bash
pnpm --dir apps/web db:preflight-entity-integrity -- --verify
```

The command reads `pg_constraint`, prints each definition, and fails if any
constraint is missing or unvalidated. Confirm the existing
`Location_parentId_idx` and both dependency `blockedBy` indexes remain present.
