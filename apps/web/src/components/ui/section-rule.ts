/**
 * The "two line weights" law: a thick ink rule opens a section, 1px solid
 * hairlines divide within it, and dashed rules are reserved for ledger rows.
 * Shared by CardHeader's `rule` prop and the recipe spread's SpreadHeading so
 * the rule weight stays in sync everywhere.
 */
export const sectionRuleClass = "border-foreground border-t-[3px] pt-1.5";
