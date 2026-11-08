import { auditEntitySchema } from "@cubby/schemas/audit";
import { entitySchema, type Entity } from "@cubby/schemas/entity";
import type { fieldExplanationSource } from "@cubby/schemas/field-explanation";
import { resolvedListSchema } from "@cubby/schemas/field-resolution";
import { humanize, parseShortcode } from "@cubby/shared";
import { z } from "zod";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { ResolvedListValue } from "~/entity/display/resolved-list-value";
import { isBrowserRoutedEntity } from "~/entity/entities";
import { formatCurrency } from "~/lib/number-format";
import { ExternalLinkText } from "~/ui/text/external-link";
import { NoneValue } from "~/ui/text/none-value";
import { DateDisplay } from "~/ui/values/date-display";

type ExplanationValue = z.infer<typeof fieldExplanationSource>["value"];
const explanationScalar = z.union([z.string(), z.number(), z.boolean()]);
const explanationResolvedList = z.array(resolvedListSchema.element.strict());
const explanationRecord = z.record(z.string(), z.json());

export function ReadableExplanationValue({
  value,
  depth = 0,
  property,
}: {
  value: ExplanationValue;
  depth?: number;
  property?: string;
}) {
  if (value === null) return <NoneValue />;
  const textValue = z.string().safeParse(value);
  if (textValue.success && property === "externalId")
    return <span className="break-words">{textValue.data}</span>;
  const reference = textValue.success ? parseShortcode(textValue.data) : null;
  if (reference)
    return (
      <ExplanationEntityLink entity={reference.type} id={reference.shortcode} />
    );
  if (textValue.success) {
    const formatted = readableExplanationText(textValue.data);
    if (formatted) return formatted;
  }
  const amount = property === "amount" ? z.number().safeParse(value) : null;
  if (amount?.success)
    return (
      <span className="font-mono tabular-nums">
        {formatCurrency(amount.data)}
      </span>
    );
  const scalar = explanationScalar.safeParse(value);
  if (scalar.success) {
    const boolean = z.boolean().safeParse(scalar.data);
    const display = boolean.success
      ? boolean.data
        ? "Yes"
        : "No"
      : textValue.success && /^[a-z]+(?:_[a-z]+)+$/.test(textValue.data)
        ? humanize(textValue.data)
        : scalar.data;
    return <span className="break-words">{display}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <NoneValue />;
    const resolved = explanationResolvedList.safeParse(value);
    if (resolved.success)
      return (
        <ResolvedListValue
          items={resolved.data}
          renderReference={(ref, label) => {
            const entity = entitySchema.safeParse(ref.entityKind);
            return entity.success ? (
              <ExplanationEntityLink
                entity={entity.data}
                id={ref.entityId}
                name={label}
              />
            ) : (
              <span>{label}</span>
            );
          }}
        />
      );
    const occurrences = new Map<string, number>();
    return (
      <ul className="grid gap-2 pl-4 text-xs">
        {value.map((item) => {
          const contentKey = JSON.stringify(item);
          const occurrence = occurrences.get(contentKey) ?? 0;
          occurrences.set(contentKey, occurrence + 1);
          return (
            <li key={`${contentKey}:${occurrence}`} className="list-disc">
              <ReadableExplanationValue value={item} depth={depth + 1} />
            </li>
          );
        })}
      </ul>
    );
  }
  return <ReadableExplanationRecord value={value} depth={depth} />;
}

function readableExplanationText(value: string) {
  if (/^https?:\/\//i.test(value) && z.url().safeParse(value).success)
    return (
      <ExternalLinkText
        href={value}
        className="max-w-full [&>span]:min-w-0 [&>span]:[overflow-wrap:anywhere]"
      />
    );
  if (z.iso.datetime({ offset: true }).safeParse(value).success)
    return <DateDisplay timestamp={value} />;
  if (z.iso.date().safeParse(value).success)
    return <DateDisplay start={value} />;
  return null;
}

function ReadableExplanationRecord({
  value,
  depth,
}: {
  value: ExplanationValue;
  depth: number;
}) {
  const record = explanationRecord.safeParse(value);
  if (!record.success) return <span>Unavailable</span>;
  const recordID = z.string().safeParse(record.data.id);
  const recordReference = recordID.success
    ? parseShortcode(recordID.data)
    : null;
  if (recordReference) {
    const recordName = z.string().safeParse(record.data.name);
    const facts = Object.fromEntries(
      Object.entries(record.data).filter(
        ([key]) => key !== "id" && key !== "name",
      ),
    );
    return (
      <div className="grid gap-1.5">
        <ExplanationEntityLink
          entity={recordReference.type}
          id={recordReference.shortcode}
          name={recordName.success ? recordName.data : null}
        />
        {Object.keys(facts).length > 0 ? (
          <ReadableExplanationValue value={facts} depth={depth} />
        ) : null}
      </div>
    );
  }
  return (
    <div className="@container">
      <dl className="grid gap-x-3 gap-y-1 text-xs @min-[18rem]:grid-cols-[minmax(5rem,0.35fr)_minmax(0,1fr)]">
        {Object.entries(record.data).map(([key, item]) => (
          <div key={key} className="contents">
            <dt className="break-words text-muted-foreground">
              {humanize(key)}
            </dt>
            <dd className="min-w-0">
              <ReadableExplanationValue
                value={item}
                depth={depth + 1}
                property={key}
              />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function ExplanationEntityLink({
  entity,
  id,
  name,
}: {
  entity: Entity;
  id: string;
  name?: string | null;
}) {
  if (name && isBrowserRoutedEntity(entity)) {
    return <EntityRefLink entity={entity} id={id} name={name} />;
  }
  const auditable = auditEntitySchema.safeParse(entity);
  return auditable.success ? (
    <EntityRefLink entity={auditable.data} id={id} name={name} />
  ) : isBrowserRoutedEntity(entity) ? (
    <EntityRefLink entity={entity} id={id} name={name ?? id} />
  ) : (
    <span className="font-mono text-xs">{id}</span>
  );
}
