import type {
  ReportCommand,
  ReportRecordRow,
} from "@cubby/schemas/entity-report";
import { type ReactNode, useState } from "react";

import { householdLocalDate } from "~/lib/household-date";
import { cn } from "~/lib/utils";
import { DateDisplay } from "~/ui/common/date-display";
import {
  RecordDetail,
  RecordDot,
  RecordList,
  RecordRow,
} from "~/ui/common/record-list";
import { Badge } from "~/ui/primitives/badge";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { ShortcodeProse } from "~/ui/shortcode-prose";

import {
  rowKeys,
  RowTitle,
  STATUS_VARIANT,
  TONE_TEXT,
} from "./records-row-parts";
import { CommandButton, type ReportCommands } from "./report-commands";

/** Whether a block can draw as a ledger: read-mostly rows, no row decision, photo or verb. */
const isLedger = (block: {
  presentation?: "filmstrip" | "ledger" | undefined;
  form?: unknown;
  rows: readonly ReportRecordRow[];
}) =>
  block.presentation === "ledger" &&
  !block.form &&
  block.rows.every(
    (row) => !row.choice && !row.imageUrl && !row.actions?.length,
  );

/**
 * How a block lays out as a ledger: the day its timed rows share, and whether the block's
 * commands sit in its header (unless the detail bar already carries them).
 */
export function ledgerLayout(
  block: Parameters<typeof isLedger>[0] & { title?: string | undefined },
  commandsInDetailBar: boolean,
) {
  const ledger = isLedger(block);
  return {
    ledger,
    // The shared day prints in the heading, so a block without one keeps dates on its rows.
    day: ledger && block.title ? ledgerDay(block.rows) : null,
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
          <ShortcodeProse>{part.text}</ShortcodeProse>
        </span>
      ))}
    </span>
  );
}

function LedgerRow({
  row,
  commands,
}: {
  row: ReportRecordRow;
  commands: ReportCommands;
}) {
  // A command that needs input opens beneath its row instead of standing open on every row.
  const [open, setOpen] = useState<string | null>(null);
  const opened = (row.commands ?? []).find((command) => command.id === open);
  const extraStatuses = (row.statuses ?? []).slice(1);
  const parts = textParts(row);
  const state = row.statuses?.[0];
  return (
    <RecordRow
      leading={<RecordDot tone={state?.tone} label={state?.label} />}
      primary={
        <span className="flex flex-wrap items-center gap-1">
          <RowTitle row={row} />
          {extraStatuses.map((status) => (
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
          {row.at ? <DateDisplay timestamp={row.at} /> : null}
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
                <Button variant="ghost" size="sm" onClick={() => setOpen(null)}>
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
          variant="outline"
          size="sm"
          aria-expanded={open === command.id}
          onClick={() => onOpen(open === command.id ? null : command.id)}
        >
          {command.label}…
        </Button>
      ) : (
        <CommandButton key={command.id} command={command} commands={commands} />
      ),
  );
  if (row.externalLink)
    items.push(
      <a
        key="external"
        href={row.externalLink.url}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        {row.externalLink.label}
      </a>,
    );
  if (items.length === 0) return null;
  return <span className="flex flex-wrap justify-end gap-1">{items}</span>;
}

/**
 * A `records` block as a ledger: one aligned line per row (state, title, text, time, commands),
 * each column as narrow as its content. Phone rows keep state, title and time on the first line
 * and drop the text and commands beneath.
 */
export function RecordLedger({
  rows,
  commands,
}: {
  rows: readonly ReportRecordRow[];
  commands: ReportCommands;
}) {
  const keys = rowKeys(rows);
  return (
    <RecordList>
      {rows.map((row, index) => (
        <LedgerRow key={keys[index]} row={row} commands={commands} />
      ))}
    </RecordList>
  );
}
