/** Convert a dollar amount to the integer-cent domain used for comparisons. */
export const cents = (value: number): number => Math.round(value * 100);

/** Convert integer cents back to dollars. */
export const dollars = (value: number): number => value / 100;

/** Round a dollar amount to whole cents, staying in dollars. */
export const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Dollar-number wires remain compatible with shipped clients. Account in bigint
 * minor units, then convert only at a checked wire/display boundary. */
const MAX_MONEY_MINOR = 100_000_000_000_000n;

export const moneyToMinor = (value: number): bigint => {
  if (!Number.isFinite(value)) throw new RangeError("Money must be finite.");
  const [coefficient, exponentText = "0"] = String(value)
    .toLowerCase()
    .split("e");
  const [whole, fraction = ""] = coefficient!.split(".");
  const digits = BigInt(`${whole}${fraction}`);
  const scale = Number(exponentText) - fraction.length + 2;
  const divisor = scale < 0 ? 10n ** BigInt(-scale) : 1n;
  if (digits % divisor !== 0n)
    throw new RangeError("Settled money must resolve to an exact whole cent.");
  const minor = scale < 0 ? digits / divisor : digits * 10n ** BigInt(scale);
  if (minor < -MAX_MONEY_MINOR || minor > MAX_MONEY_MINOR)
    throw new RangeError(
      "Money exceeds the supported dollar-number wire range.",
    );
  return minor;
};

export const minorToMoney = (minor: bigint): number => {
  if (minor < -MAX_MONEY_MINOR || minor > MAX_MONEY_MINOR)
    throw new RangeError(
      "Money exceeds the supported dollar-number wire range.",
    );
  const value = Number(minor) / 100;
  if (moneyToMinor(value) !== minor)
    throw new RangeError(
      "Money cannot round-trip through the dollar-number wire.",
    );
  return value;
};
