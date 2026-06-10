/**
 * The "two line weights" law: a thick ink rule opens a section, 1px solid
 * hairlines divide within it, and dashed rules are reserved for ledger rows.
 * The rule belongs ONLY on un-carded sections (the magazine SpreadHeading,
 * form section headers) — inside a bordered card it reads as a competing
 * second frame, so card titles stay bare eyebrows.
 */
export const sectionRuleClass = "border-foreground border-t-[3px] pt-1.5";
