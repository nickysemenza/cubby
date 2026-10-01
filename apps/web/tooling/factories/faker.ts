import { createHash } from "node:crypto";

import { en, Faker } from "@faker-js/faker";

/**
 * Seeded Faker for test and dev data.
 *
 * Faker fills fields nothing asserts on (a product's manufacturer, a vendor's
 * website). It never produces a name a locator or assertion depends on — those
 * stay `${label} ${deterministicToken(...)}` — and never produces shortcodes or
 * UPCs, which come from `@cubby/shared` generators or known-valid literals.
 *
 * Dev tooling only: `@faker-js/faker` is a devDependency and must never reach
 * the Worker bundle (`tooling/factories/worker-bundle-guard.unit.test.ts`).
 */

/** The Playwright annotation type that records a test's Faker seed. */
export const FAKER_SEED_ANNOTATION = "faker-seed";

/** The dev corpus seed: the same synthetic household on every `dev:seed`. */
export const DEV_FAKER_SEED = 1;

/** A stable 32-bit hash of the parts, so equal inputs always pick one seed. */
export function hashSeed(...parts: readonly (string | number)[]): number {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest();
  return digest.readUInt32BE(0);
}

/**
 * A short lowercase base-36 token that is a pure function of its parts. Used
 * where a record name must be unique across tests yet reproducible: the same
 * test title produces the same name on every run, so a failure replays.
 */
export function deterministicToken(
  ...parts: readonly (string | number)[]
): string {
  return hashSeed(...parts)
    .toString(36)
    .padStart(7, "0")
    .slice(-6);
}

/**
 * An isolated Faker instance. Never the shared global: another test (or the
 * schema `mock()` generator) drawing from it would shift this one's sequence.
 * Derive the seed with {@link hashSeed} to key it on a name.
 */
export function fakerFromSeed(seed: number): Faker {
  const faker = new Faker({ locale: [en] });
  faker.seed(seed);
  return faker;
}
