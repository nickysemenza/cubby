import type {
  ReportCommand,
  ReportRecordRow,
} from "@cubby/schemas/entity-report";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { type ReactNode, useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entities, entityDetailParams } from "~/entity/entities";
import { householdLocalDate } from "~/lib/household-date";
import { cn } from "~/lib/utils";
import { DateDisplay } from "~/ui/common/date-display";
import {
  RecordDetail,
  RecordDot,
  RecordHeading,
  RecordList,
  RecordRow,
} from "~/ui/common/record-list";
import { Badge } from "~/ui/primitives/badge";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { ShortcodeProse } from "~/ui/shortcode-prose";

import {
  routedEntity,
  rowKeys,
  STATUS_VARIANT,
  TONE_TEXT,
} from "./records-row-parts";
import { CommandButton, type ReportCommands } from "./report-commands";

type LedgerBlock = {
  presentation?: "filmstrip" | "ledger" | "timeline" | undefined;
  form?: unknown;
  rows: readonly ReportRecordRow[];
};

/** Whether a block can draw as a ledger: read-mostly rows, no row decision, photo or verb. */
const isLedger = (block: LedgerBlock) =>
  (block.presentation === "ledger" || block.presentation === "timeline") &&
  !block.form &&
  block.rows.every(
    (row) => !row.choice && !row.imageUrl && !row.actions?.length,
  );

/**
 * How a block lays out as a ledger: the day its timed rows share, and whether the block's
 * commands sit in its header (unless the detail bar already carries them).
 */
export function ledgerLayout(
  block: LedgerBlock & { title?: string | undefined },
  commandsInDetailBar: boolean,
) {
  const ledger = isLedger(block);
  return {
    ledger,
    // Rows that share a day print only their time; the day prints once above them.
    day: ledger ? ledgerDay(block.rows) : null,
    headerCommands: ledger && !commandsInDetailBar,
  };
}

/** A shared household day for the records heading; null when rows span days. */
function ledgerDay(rows: readonly ReportRecordRow[]) {
  const days = new Set(
    rows.flatMap((row) =>
      row.at && !Number.isNaN(new Date(row.at).getTime())
        ? [householdLocalDate(new Date(row.at))]
        : [],
    ),
  );
  return days.size === 1 ? [...days][0]! : null;
}

/** Failures and warnings wrap in full: a raw diagnostic is never clipped behind a tooltip. */
const isLoud = (row: ReportRecordRow) =>
  row.state?.kind === "failed" ||
  row.state?.kind === "warning" ||
  [
    ...(row.statuses ?? []).map((status) => status.tone),
    ...(row.lines ?? []).map((line) => line.tone),
  ].some((tone) => tone === "destructive" || tone === "warning");

/** The subtitle's first line is the result; its other lines and the toned lines are evidence. */
const textParts = (row: ReportRecordRow) => {
  const [result, ...evidence] = (row.subtitle ?? "")
    .split("\n")
    .filter((line) => line !== "");
  return [
    ...(result ? [{ text: result, className: "text-foreground" }] : []),
    ...evidence.map((text) => ({ text, className: "text-muted-foreground" })),
    ...(row.lines ?? []).map((line) => ({
      text: line.text,
      className: line.tone ? TONE_TEXT[line.tone] : "text-muted-foreground",
    })),
  ].map((part, position) => ({ ...part, key: `${position}:${part.text}` }));
};

/** A whole part that is a machine code (`source_too_large`) reads as one, in mono. */
const isCode = (text: string) => /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(text);

/** The row's text on one line, clipped with the whole text as its tooltip unless it is loud. */
function RowText({
  row,
  parts,
}: {
  row: ReportRecordRow;
  parts: ReturnType<typeof textParts>;
}) {
  const loud = isLoud(row);
  return (
    <span
      className={cn(
        "block min-w-0 text-xs/5 break-words",
        loud ? "whitespace-pre-line" : "@min-[32rem]/ledger:truncate",
      )}
      title={loud ? undefined : parts.map((part) => part.text).join(" · ")}
    >
      {parts.map((part, index) => (
        <span key={part.key} className={part.className}>
          {index > 0 ? (
            <span className="text-muted-foreground"> · </span>
          ) : null}
          {isCode(part.text) ? (
            <code className="font-mono text-2xs">{part.text}</code>
          ) : (
            <ShortcodeProse>{part.text}</ShortcodeProse>
          )}
        </span>
      ))}
    </span>
  );
}

/** A ledger title is plain text, linked when the row opens a record: rows read as one column. */
function LedgerTitle({ row }: { row: ReportRecordRow }) {
  const entity = routedEntity(row.entity);
  if (row.title === "") return null;
  if (entity === null || row.id === null)
    return (
      <span className="font-medium whitespace-pre-line">
        <ShortcodeProse>{row.title}</ShortcodeProse>
      </span>
    );
  return (
    <EntityRefLink
      variant="table"
      tone="identity"
      to={entities[entity].routes.detail}
      params={entityDetailParams(row.id)}
      title={row.id}
    >
      {row.title}
    </EntityRefLink>
  );
}

function LedgerRow({
  row,
  commands,
  sharedDay,
}: {
  row: ReportRecordRow;
  commands: ReportCommands;
  sharedDay: boolean;
}) {
  // A command that needs input opens beneath its row instead of standing open on every row.
  const [open, setOpen] = useState<string | null>(null);
  const opened = (row.commands ?? []).find((command) => command.id === open);
  const parts = textParts(row);
  return (
    <RecordRow
      leading={<RecordDot state={row.state?.kind} label={row.state?.label} />}
      primary={
        <span className="flex flex-wrap items-center gap-1">
          <LedgerTitle row={row} />
          {(row.statuses ?? []).map((status) => (
            <Badge
              key={status.label}
              variant={status.tone ? STATUS_VARIANT[status.tone] : "secondary"}
            >
              {status.label}
            </Badge>
          ))}
          {(row.badges ?? []).map((badge) => (
            <Badge key={badge} variant="warning">
              {badge}
            </Badge>
          ))}
        </span>
      }
      clip={false}
      secondary={parts.length > 0 ? <RowText row={row} parts={parts} /> : null}
      trailing={
        <>
          {row.trailing ? <span>{row.trailing} </span> : null}
          {row.at ? (
            <DateDisplay
              timestamp={row.at}
              clock={sharedDay ? "time" : "day"}
            />
          ) : null}
        </>
      }
      actions={
        row.commands?.length || row.externalLink ? (
          <LedgerCommands
            row={row}
            commands={commands}
            open={open}
            onOpen={setOpen}
          />
        ) : null
      }
      detail={
        opened || row.detail ? (
          <>
            {opened ? (
              <div className="flex flex-wrap items-center gap-2">
                <CommandButton command={opened} commands={commands} compact />
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => setOpen(null)}
                >
                  Cancel
                </Button>
              </div>
            ) : null}
            {row.detail ? (
              <RecordDetail summary={row.detail.label}>
                <pre className="max-h-80 overflow-auto bg-muted/30 p-2 font-mono break-words whitespace-pre-wrap">
                  {row.detail.text}
                </pre>
              </RecordDetail>
            ) : null}
          </>
        ) : null
      }
    />
  );
}

function LedgerCommands({
  row,
  commands,
  open,
  onOpen,
}: {
  row: ReportRecordRow;
  commands: ReportCommands;
  open: string | null;
  onOpen: (id: string | null) => void;
}) {
  const items: ReactNode[] = (row.commands ?? []).map(
    (command: ReportCommand) =>
      command.inputs?.length ? (
        <Button
          key={command.id}
          variant="ghost"
          size="sm"
          className="h-6"
          aria-expanded={open === command.id}
          onClick={() => onOpen(open === command.id ? null : command.id)}
        >
          {command.label}…
        </Button>
      ) : (
        <CommandButton
          key={command.id}
          command={command}
          commands={commands}
          quiet
        />
      ),
  );
  if (row.externalLink)
    items.push(
      <a
        key="external"
        href={row.externalLink.url}
        title={row.externalLink.hint}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({
          variant: "ghost",
          size: "sm",
          className: "h-6",
        })}
      >
        {row.externalLink.label}
        <ArrowSquareOutIcon aria-hidden data-icon="inline-end" />
      </a>,
    );
  if (items.length === 0) return null;
  return (
    // Phone rows put commands under the text, aligned with it; wide rows end the line with them.
    <span className="-ml-2 flex flex-wrap justify-start gap-0.5 @min-[32rem]/ledger:ml-0 @min-[32rem]/ledger:justify-end">
      {items}
    </span>
  );
}

/**
 * A `records` block as a ledger: one aligned line per row (state, title, text, time, commands),
 * each column as narrow as its content. A `timeline` block draws a rail through its ordered
 * stages. Rows that share `day` print only their time; an untitled block prints that day as its
 * first line (a titled block prints it in its heading). Phone rows keep state, title and time on
 * the first line and drop the text and commands beneath.
 */
export function RecordLedger({
  rows,
  commands,
  timeline = false,
  day = null,
  dayHeading = false,
}: {
  rows: readonly ReportRecordRow[];
  commands: ReportCommands;
  timeline?: boolean;
  day?: string | null;
  dayHeading?: boolean;
}) {
  const keys = rowKeys(rows);
  return (
    <RecordList variant={timeline ? "timeline" : "plain"}>
      {day && dayHeading ? (
        <RecordHeading label={<DateDisplay start={day} />} />
      ) : null}
      {rows.map((row, index) => (
        <LedgerRow
          key={keys[index]}
          row={row}
          commands={commands}
          sharedDay={day !== null}
        />
      ))}
    </RecordList>
  );
}
