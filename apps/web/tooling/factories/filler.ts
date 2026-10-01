import type { Faker } from "@faker-js/faker";

/**
 * Where a default value for an unasserted field comes from.
 *
 * Without a Faker the filler is literal and stable ("Test Product"): the repo
 * integration fixtures assert on those defaults. With one it is varied but
 * seeded, so a dev corpus or an E2E record reads like a household's data and
 * still reproduces from its seed.
 */
export interface Filler {
  /**
   * A display name for an entity of kind `label`. Never use a filler name as a
   * locator or assertion target: a test that asserts on a name passes it as an
   * override, shaped `${label} ${deterministicToken(...)}`.
   */
  name(label: string): string;
  company(): string;
}

const LITERAL_FILLER: Filler = {
  name: (label) => `Test ${label}`,
  company: () => "Test Manufacturer",
};

/** A 4-character suffix so two fillers from one seed rarely collide on a unique name index. */
const suffix = (faker: Faker): string =>
  faker.string.alphanumeric({ length: 4, casing: "lower" });

const fakerFiller = (faker: Faker): Filler => ({
  // Words only: no apostrophes or punctuation that would break a name regex.
  name: (label) => `${label} ${faker.word.adjective()} ${suffix(faker)}`,
  company: () => `${faker.word.noun()} ${faker.word.noun()} Works`,
});

export const fillerFor = (faker: Faker | undefined): Filler =>
  faker ? fakerFiller(faker) : LITERAL_FILLER;
