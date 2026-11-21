-- Reopen emailState and transferPair scopes that a Worker without their
-- reconcilers parked as unregistered, the way a new input resets a scope.
UPDATE "ScopeDirty" SET attempts = 0, "availableAt" = LEAST("availableAt", now()), "lastError" = NULL
WHERE "scopeKind" IN ('emailState', 'transferPair')
  AND "lastError" = 'Unregistered reconciler: ' || "scopeKind";
