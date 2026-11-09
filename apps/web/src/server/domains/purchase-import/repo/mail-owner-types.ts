export type MailParty = { name: string; addresses: readonly string[] };

/** The Email's owner LedgerParty and the household's other live members. */
export type MailOwnerEvidence = {
  owner: MailParty;
  householdMembers: readonly MailParty[];
};

/** Owner evidence and the gaps in it, e.g. an unreadable Gmail profile. */
export type MailOwnerContext = {
  evidence: MailOwnerEvidence | null;
  warnings: readonly string[];
};
