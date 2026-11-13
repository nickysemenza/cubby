/** Expense allocation cents by role and party, and accepted receipt line cents. */
export function replacementAttributions(input: {
  allocations: readonly {
    role: "beneficiary" | "funder";
    ledgerPartyId: string | null;
    allocationKey: string;
    cents: bigint;
  }[];
  lines: readonly { amountMinor: bigint | null }[];
}) {
  const abs = (value: bigint) => (value < 0n ? -value : value);
  const sign = (value: bigint) => (value < 0n ? -1n : value > 0n ? 1n : 0n);
  const result: {
    lineIndex: number;
    role: "beneficiary" | "funder";
    partyId: string | null;
    partyCode: string;
    weightMinor: bigint;
    amountMinor: bigint;
  }[] = [];
  for (const role of new Set(input.allocations.map((row) => row.role))) {
    const targets = input.allocations.filter((row) => row.role === role);
    const direction =
      targets.reduce((sum, row) => sum + row.cents, 0n) < 0n ? -1n : 1n;
    const totalWeight = targets.reduce((sum, row) => sum + abs(row.cents), 0n);
    const opposite = input.lines.reduce(
      (sum, row) =>
        sum +
        (row.amountMinor !== null && sign(row.amountMinor) === -direction
          ? abs(row.amountMinor)
          : 0n),
      0n,
    );
    const denominator =
      totalWeight === 0n ? BigInt(targets.length) : totalWeight;
    const shares = targets
      .map((row) => {
        const weight = totalWeight === 0n ? 1n : abs(row.cents);
        return {
          row,
          base: (opposite * weight) / denominator,
          remainder: (opposite * weight) % denominator,
        };
      })
      .sort((a, b) =>
        a.remainder !== b.remainder
          ? a.remainder > b.remainder
            ? -1
            : 1
          : a.row.allocationKey.localeCompare(b.row.allocationKey),
      );
    const remaining =
      opposite - shares.reduce((sum, row) => sum + row.base, 0n);
    const margins = shares
      .map((share, index) => ({
        ...share.row,
        share: share.base + (BigInt(index) < remaining ? 1n : 0n),
      }))
      .sort((a, b) => a.allocationKey.localeCompare(b.allocationKey));
    for (const side of [direction, -direction]) {
      let partyStart = 0n;
      for (const target of margins) {
        const partyFinish =
          partyStart +
          (side === direction
            ? abs(target.cents) + target.share
            : target.share);
        let lineStart = 0n;
        for (const [lineIndex, line] of input.lines.entries()) {
          if (line.amountMinor === null || sign(line.amountMinor) !== side)
            continue;
          const lineFinish = lineStart + abs(line.amountMinor);
          const start = lineStart > partyStart ? lineStart : partyStart;
          const finish = lineFinish < partyFinish ? lineFinish : partyFinish;
          if (finish > start)
            result.push({
              lineIndex,
              role,
              partyId: target.ledgerPartyId,
              partyCode: target.allocationKey,
              weightMinor: finish - start,
              amountMinor: side * (finish - start),
            });
          lineStart = lineFinish;
        }
        partyStart = partyFinish;
      }
    }
  }
  return result.sort(
    (a, b) =>
      a.lineIndex - b.lineIndex ||
      a.role.localeCompare(b.role) ||
      a.partyCode.localeCompare(b.partyCode),
  );
}
