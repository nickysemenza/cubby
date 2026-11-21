CREATE INDEX "Decision_link_event_idx" ON "Decision" (("value"->>'eventId')) WHERE "field" LIKE 'link:%';
--> statement-breakpoint
-- Reopen emailState and transferPair scopes that a Worker without their
-- reconcilers parked as unregistered, the way a new input resets a scope.
UPDATE "ScopeDirty" SET attempts = 0, "availableAt" = LEAST("availableAt", now()), "lastError" = NULL
WHERE "scopeKind" IN ('emailState', 'transferPair')
  AND "lastError" = 'Unregistered reconciler: ' || "scopeKind";
