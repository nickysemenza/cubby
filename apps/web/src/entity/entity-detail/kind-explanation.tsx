/** What one kind of record does, from its kind option's declared `explanation`. */
export interface KindExplanationValue {
  targets: string;
  exclusions: string;
  effects: string;
  dependencies: string;
  cost: string;
  recovery: string;
}

const ROWS = [
  ["targets", "Targets"],
  ["exclusions", "Skips"],
  ["effects", "Effects"],
  ["dependencies", "Needs"],
  ["cost", "Cost"],
  ["recovery", "Recovery"],
] as const satisfies ReadonlyArray<
  readonly [keyof KindExplanationValue, string]
>;

const article = (label: string) => (/^[aeiou]/iu.test(label) ? "an" : "a");

/**
 * "What a Sweep does": the kind option's description, then its targets, exclusions, effects, dependencies,
 * cost and recovery, each label over its value so the narrow side column
 * reads them without a label gutter.
 */
export function KindExplanation({
  label,
  description,
  explanation,
}: {
  label: string;
  description?: string;
  explanation: KindExplanationValue;
}) {
  const title = `What ${article(label)} ${label} does`;
  return (
    <section aria-label={title} data-kind-explanation className="min-w-0">
      <h2 className="mb-1.5 text-sm font-semibold text-foreground-strong">
        {title}
      </h2>
      {description ? (
        <p className="mb-1.5 text-sm text-foreground">{description}</p>
      ) : null}
      <dl className="divide-y divide-border text-sm">
        {ROWS.map(([key, rowLabel]) => (
          <div key={key} className="py-1.5 first:pt-0">
            <dt className="text-xs font-semibold text-muted-foreground">
              {rowLabel}
            </dt>
            <dd className="text-foreground">{explanation[key]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
