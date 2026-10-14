import type { ReportBlock } from "@cubby/schemas/entity-report";
import { type ReactNode, Suspense, useState } from "react";

import { DateDisplay } from "~/ui/common/date-display";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { Eyebrow } from "~/ui/primitives/eyebrow";
import { Image } from "~/ui/primitives/image";
import { Skeleton } from "~/ui/primitives/skeleton";
import { ShortcodeProse } from "~/ui/shortcode-prose";

import {
  DetailAction,
  type ReportDetailActionPlacement,
} from "./detail-action-bar";
import {
  ledgerDay,
  type LedgerContext,
  RecordLedger,
  RowLinks,
} from "./records-ledger";
import { useChoiceAnswers, ChoiceFormFooter } from "./report-choices";
import { CommandButton, useReportCommands } from "./report-commands";
import { sectionActionsFor } from "./section-actions";

export type RecordsBlock = Extract<ReportBlock, { kind: "records" }>;

function RowActionPlacement({
  inDetailBar,
  children,
}: {
  inDetailBar: boolean;
  children: ReactNode;
}) {
  return inDetailBar ? <DetailAction>{children}</DetailAction> : children;
}

function RecordFilmstrip({
  block,
  context,
}: {
  block: RecordsBlock;
  context: LedgerContext;
}) {
  const [selectedKey, setSelectedKey] = useState<string>();
  const [offset, setOffset] = useState(0);
  const selected =
    block.rows.find((row) => row.key === selectedKey) ?? block.rows[0];
  const start = Math.min(
    offset,
    Math.max(0, Math.floor((block.rows.length - 1) / 8) * 8),
  );
  if (!selected) return null;
  return (
    <Stack gap="sm" className="min-w-0">
      <Row gap="sm" className="flex-wrap">
        {block.rows.slice(start, start + 8).map((row) => (
          <Button
            key={row.key ?? row.title}
            variant={row === selected ? "secondary" : "outline"}
            aria-label={`View ${row.title}`}
            aria-pressed={row === selected}
            onClick={() => setSelectedKey(row.key)}
          >
            {row.imageUrl ? (
              <Image
                src={row.imageUrl}
                alt=""
                displayWidth={64}
                className="size-12 object-contain"
              />
            ) : null}
            {row.title}
          </Button>
        ))}
      </Row>
      <Row gap="sm">
        <Button
          variant="outline"
          disabled={start === 0}
          onClick={() => setOffset(start - 8)}
        >
          Previous captures
        </Button>
        <span className="text-sm text-muted-foreground">
          {start + 1}–{Math.min(start + 8, block.rows.length)} of{" "}
          {block.rows.length}
        </span>
        <Button
          variant="outline"
          disabled={start + 8 >= block.rows.length}
          onClick={() => setOffset(start + 8)}
        >
          Next captures
        </Button>
      </Row>
      <section
        aria-label="Selected record"
        className="grid min-w-0 gap-4 md:grid-cols-2"
      >
        {selected.imageUrl ? (
          <a
            href={selected.imageUrl}
            target="_blank"
            rel="noreferrer"
            className="min-w-0"
          >
            <Image
              src={selected.imageUrl}
              alt={selected.title}
              displayWidth={800}
              className="max-h-[32rem] w-full rounded-md border border-border object-contain"
            />
          </a>
        ) : null}
        <RecordLedger
          rows={[{ ...selected, imageUrl: undefined }]}
          context={{ ...context, choices: null, record: undefined }}
        />
      </section>
    </Stack>
  );
}

/** The block's rows in its presentation, or its empty copy. */
function RecordsRows({
  block,
  context,
}: {
  block: RecordsBlock;
  context: LedgerContext;
}) {
  if (block.presentation === "filmstrip")
    return <RecordFilmstrip block={block} context={context} />;
  if (block.rows.length === 0)
    return block.empty ? <Description>{block.empty}</Description> : null;
  return (
    <RecordLedger
      rows={block.rows}
      context={context}
      timeline={block.presentation === "timeline"}
      dayHeading={!block.title}
    />
  );
}

/** The block's eyebrow with the day its timed rows share; an empty block shows only its copy. */
function RecordsHeader({
  title,
  day,
}: {
  title: string | undefined;
  day: string | null;
}) {
  if (!title) return null;
  return (
    <Eyebrow>
      {title}
      {day ? (
        <>
          {" "}
          · <DateDisplay start={day} />
        </>
      ) : null}
    </Eyebrow>
  );
}

/**
 * The `records` report block: the server's rows, each opening the record it names, with the
 * row verbs the server offered. `record` is the loaded detail record those verbs act on; the
 * slot's own verbs are shown by `EntityReportSlot`, so they survive a loading or failed report.
 */
export function RecordsBlockView({
  block,
  detailActions,
  record,
  entity,
  list,
}: {
  detailActions?: ReportDetailActionPlacement;
  block: RecordsBlock;
  record?: object;
  /** The record's entity, for the finance verbs the block offers (`block.verbs`). */
  entity?: string;
  /** Replaces the generic rows and footer (a sortable table, thumbnails). */
  list?: ReactNode;
}) {
  const commands = useReportCommands();
  const choices = useChoiceAnswers();
  const { form } = block;
  const choicesLocked = commands.pending || commands.committed;
  const verbs = block.verbs ?? [];
  const available =
    entity === undefined || record === undefined
      ? {}
      : sectionActionsFor(entity);
  // SAFETY: the verb registry is keyed by this entity, so it takes this entity's record.
  const erasedRecord = record as never;
  const context: LedgerContext = {
    commands,
    day: ledgerDay(block.rows),
    marks:
      block.presentation === "timeline" ||
      block.rows.some((row) => row.state !== undefined),
    large: block.thumbnail === "large",
    choices: form ? choices : null,
    choicesLocked,
    record,
    detailRows: detailActions?.rows,
  };
  const blockCommands = (block.commands ?? []).map((command) => (
    <CommandButton key={command.id} command={command} commands={commands} />
  ));
  return (
    <Stack as="section" aria-label={block.title} gap="sm" className="w-full">
      <RecordsHeader
        title={block.rows.length > 0 ? block.title : undefined}
        day={context.day}
      />
      {list ?? <RecordsRows block={block} context={context} />}
      {block.footer && list === undefined ? (
        <p className="border-t border-border pt-2 text-sm text-muted-foreground">
          <ShortcodeProse>{block.footer}</ShortcodeProse>
        </p>
      ) : null}
      {form ? (
        <ChoiceFormFooter
          form={form}
          rowChoices={block.rows.flatMap((row) =>
            row.choice ? [row.choice] : [],
          )}
          state={choices}
          pending={commands.pending}
          done={commands.committed}
          onRun={() =>
            commands.commit(
              form.command.request,
              choices.answers,
              choices.operationId,
            )
          }
        />
      ) : null}
      {blockCommands.length > 0 ? (
        // The detail page's action bar carries them instead, when it has them.
        <RowActionPlacement inDetailBar={detailActions?.commands ?? false}>
          <Row wrap gap="sm">
            {blockCommands}
          </Row>
        </RowActionPlacement>
      ) : null}
      {verbs.length > 0 ? (
        <Row gap="sm" wrap align="center" aria-live="polite">
          {verbs.map((verb) => {
            const Verb = available[verb.id];
            return Verb ? (
              <Suspense
                key={verb.id}
                fallback={<Skeleton className="h-8 w-24" />}
              >
                <RowActionPlacement inDetailBar={detailActions?.verbs ?? false}>
                  <Verb record={erasedRecord} action={verb} />
                </RowActionPlacement>
              </Suspense>
            ) : null;
          })}
        </Row>
      ) : null}
      {verbs.map((verb) =>
        verb.disabledReason ? (
          <Description key={verb.id} size="xs">
            {verb.label}: {verb.disabledReason}
          </Description>
        ) : null,
      )}
    </Stack>
  );
}

export function RecordsDetailActions({
  block,
  detailActions,
  entity,
  record,
}: {
  block: RecordsBlock;
  detailActions?: ReportDetailActionPlacement;
  entity?: string;
  record?: object;
}) {
  const commands = useReportCommands();
  const available = entity === undefined ? {} : sectionActionsFor(entity);
  // SAFETY: the action registry correlates this entity with its loaded record.
  const erasedRecord = record as never;
  return (
    <>
      {block.rows
        .filter(
          (row) =>
            row.key !== undefined && detailActions?.rows?.includes(row.key),
        )
        .map((row) => (
          <RowLinks key={row.key} row={row} commands={commands} />
        ))}
      {detailActions?.verbs && record
        ? (block.verbs ?? []).map((verb) => {
            const Verb = available[verb.id];
            return Verb ? (
              <Suspense key={verb.id} fallback={null}>
                <span title={verb.disabledReason ?? undefined}>
                  <Verb record={erasedRecord} action={verb} />
                </span>
              </Suspense>
            ) : null;
          })
        : null}
      {detailActions?.commands
        ? (block.commands ?? []).map((command) => (
            <CommandButton
              key={command.id}
              command={command}
              commands={commands}
            />
          ))
        : null}
    </>
  );
}
