/**
 * Claim removal for the duplicate-financial-identifier fixes. A claim is the
 * exact (source, identifier) pair the detector grouped on: another source's
 * identical id, or a different id from the same source, is a different claim
 * and must survive.
 */

type SourceRef = { source: string; externalId: string };
type SourceAlias = { source: string; externalAccountId: string | null };

export const withoutSourceRef = <T extends SourceRef>(
  refs: readonly T[],
  claim: SourceRef,
): T[] =>
  refs.filter(
    (ref) =>
      !(ref.source === claim.source && ref.externalId === claim.externalId),
  );

export const withoutSourceAlias = <T extends SourceAlias>(
  aliases: readonly T[],
  claim: { source: string; externalAccountId: string },
): T[] =>
  aliases.filter(
    (alias) =>
      !(
        alias.source === claim.source &&
        alias.externalAccountId === claim.externalAccountId
      ),
  );
