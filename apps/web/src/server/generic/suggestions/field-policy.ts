/** Inputs gathered for one automatic field decision. */
export type AutomaticFieldInput = {
  entity: string;
  field: string;
  eligible: boolean;
  saved: boolean;
  provenanceCurrent: boolean;
  subjectExists: boolean;
  hasEvidence: boolean;
  holder: "open" | "cubby" | "person";
  explicitNone: boolean;
  currentAvailable: boolean;
  effectiveEmpty: boolean;
  fillOnly: boolean;
  confidence: number;
  runnerUpConfidence: number | null;
  rejected: boolean;
  replaced: boolean;
};

export const fieldValueIsEmpty = <T>(value: T) => value == null || value === "";
export const personHoldsField = (holder: AutomaticFieldInput["holder"]) =>
  holder === "person";

/** Decide in the same order as the automatic field write's safety checks. */
export function decideAutomaticField(
  input: AutomaticFieldInput,
): { kind: "apply" } | { kind: "refuse"; reason: string } {
  const refuse = (reason: string) => ({ kind: "refuse" as const, reason });
  if (!input.eligible)
    return refuse(
      `Field ${input.entity}.${input.field} is not eligible for automatic fill`,
    );
  if (!input.saved)
    return refuse("Only a saved field suggestion can apply automatically");
  if (!input.provenanceCurrent)
    return refuse(
      "Automatic fill requires current complete AI policy provenance",
    );
  if (!input.subjectExists)
    return refuse("Automatic fill subject no longer exists");
  if (!input.hasEvidence)
    return refuse("Automatic fill requires supporting field evidence");
  if (personHoldsField(input.holder))
    return refuse("Automatic fill preserves a person's value");
  if (input.explicitNone)
    return refuse("Automatic fill preserves an existing field decision");
  if (!input.currentAvailable)
    return refuse("Automatic fill requires an available current field result");
  if (input.holder === "open" && !input.effectiveEmpty)
    return refuse("Automatic fill preserves populated effective values");
  if (input.holder === "cubby" && !input.effectiveEmpty) {
    if (input.fillOnly)
      return refuse("Other records inherit this field; Cubby only fills it");
    if (input.confidence - (input.runnerUpConfidence ?? 0) < 0.2)
      return refuse("A replacement must clearly beat Cubby's current value");
  }
  if (input.rejected)
    return refuse("Automatic fill preserves a rejected value");
  if (input.holder === "cubby" && input.replaced)
    return refuse("Cubby already replaced this value once");
  return { kind: "apply" };
}
