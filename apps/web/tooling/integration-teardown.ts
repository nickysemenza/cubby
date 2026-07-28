import { afterAll } from "vitest";
import { closeTestDb } from "./test-setup";

/**
 * File-level teardown for the integration project (a vitest `setupFiles`
 * entry, so this `afterAll` is scoped to the whole test file).
 *
 * `withTestDb()` caches one IntegreSQL database per file; this hands it back
 * when the file finishes. Registering it here rather than inside `withTestDb()`
 * is what makes it file-scoped — see `closeTestDb`.
 */
afterAll(async () => {
  await closeTestDb();
});
