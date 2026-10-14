import { type ReportBlock, reportBlock } from "@cubby/schemas/entity-report";
import { useState } from "react";

import { RecordsBlockView } from "~/entity/entity-detail/records-block";
import { Ledger, LedgerCell, LedgerRow } from "~/ui/common/ledger";
import {
  RecordDetail,
  RecordDot,
  RecordFold,
  RecordGroup,
  RecordHeading,
  RecordHops,
  RecordList,
  RecordMore,
  RecordRow,
  RecordScore,
} from "~/ui/common/record-list";
import { Stack } from "~/ui/layout";

import { Demo, DemoGrid } from "../_components/design-section";
import { EditableComponentDemo } from "../_components/EditableComponentDemo";
import {
  demoFilmstripBlock,
  demoLedgerBlock,
  demoProducts,
  demoTimelineBlock,
} from "../_data/samples";

const renderBlock = (block: ReportBlock) =>
  block.kind === "records" ? <RecordsBlockView block={block} /> : null;

const FACTS = [
  ["Category", "Dairy alternatives"],
  ["Stored in", "Fridge door"],
  ["Pack size", "1 L carton"],
  [
    "Notes",
    "Shake before pouring. Keeps about a week once opened, so buy two at a time.",
  ],
] as const;

const KIND_COLORS = {
  created: "var(--positive)",
  edited: "var(--domain-plan)",
  moved: "var(--domain-house)",
} as const;

function RecordPrimitivesDemo() {
  const [expanded, setExpanded] = useState(false);
  const similar = expanded
    ? demoProducts.slice(0, 6)
    : demoProducts.slice(0, 3);
  return (
    <RecordList aria-label="Connected records">
      <RecordGroup
        label="Similar products"
        count={6}
        more={
          expanded ? null : (
            <RecordMore label="+3 more" onClick={() => setExpanded(true)} />
          )
        }
      >
        {similar.map((item, index) => (
          <RecordRow
            key={item.id}
            leading={<span aria-hidden>{item.emoji}</span>}
            primary={<span className="truncate">{item.name}</span>}
            secondary={item.location}
            trailing={
              <RecordScore
                value={0.92 - index * 0.11}
                label={`${Math.round((0.92 - index * 0.11) * 100)}% similar`}
              />
            }
          />
        ))}
      </RecordGroup>
      <RecordGroup label="Physical connections" count={2}>
        <RecordRow
          leading={<RecordDot tone="positive" label="Verified" />}
          primary="Pantry · Top shelf"
          secondary="Stored in, verified on the last sweep"
          trailing={<RecordHops count={1} />}
        />
        <RecordRow
          leading={<RecordDot tone="warning" label="Unverified" />}
          primary="Kitchen"
          secondary="Through Pantry"
          trailing={<RecordHops count={2} />}
          detail={
            <RecordDetail summary="Why this connection">
              <p className="text-muted-foreground">
                Pantry is inside Kitchen, so everything on its shelves is too.
              </p>
            </RecordDetail>
          }
        />
      </RecordGroup>
      <RecordFold>
        No recipes, cookbooks or projects use this product
      </RecordFold>
    </RecordList>
  );
}

function ActivityTimelineDemo() {
  const events = [
    ["08:15", "created", "Created from an order Email", "Household member"],
    ["09:02", "edited", "Category set to Dairy", "Suggestion accepted"],
    ["12:40", "moved", "Moved to Fridge door", "Household member"],
  ] as const;
  return (
    <RecordList variant="timeline" aria-label="Activity">
      <RecordHeading label="Today" count={events.length} />
      {events.map(([time, kind, title, actor]) => (
        <RecordRow
          key={time}
          leading={
            <RecordDot color={KIND_COLORS[kind]} label={kind} spoken={false} />
          }
          primary={title}
          secondary={actor}
          trailing={<span className="font-mono tabular-nums">{time}</span>}
        />
      ))}
    </RecordList>
  );
}

export function RecordsSection() {
  return (
    <Stack gap="md">
      <div className="grid gap-4 xl:grid-cols-2">
        <EditableComponentDemo
          title='RecordsBlockView · kind: "records"'
          description="Every report records block draws as one ledger: thumbnail, title, toned badges, result and evidence lines, figure and time."
          schema={reportBlock}
          defaultData={demoLedgerBlock}
        >
          {renderBlock}
        </EditableComponentDemo>
        <EditableComponentDemo
          title='RecordsBlockView · presentation: "timeline"'
          description="Ordered stages draw a rail from the first mark to the last, one distinct mark per state."
          schema={reportBlock}
          defaultData={demoTimelineBlock}
        >
          {renderBlock}
        </EditableComponentDemo>
        <EditableComponentDemo
          title='RecordsBlockView · presentation: "filmstrip"'
          description="Photo captures page through large thumbnails."
          schema={reportBlock}
          defaultData={demoFilmstripBlock}
        >
          {renderBlock}
        </EditableComponentDemo>
      </div>
      <DemoGrid>
        <Demo
          name={'<Ledger as="dl" variant="facts">'}
          note="Scalar facts: a bounded label column, aligned values, quiet rules."
        >
          <Ledger as="dl" variant="facts">
            {FACTS.map(([label, value]) => (
              <LedgerRow as="div" key={label}>
                <LedgerCell
                  as="dt"
                  slot="primary"
                  className="text-muted-foreground"
                >
                  {label}
                </LedgerCell>
                <LedgerCell as="dd" slot="secondary">
                  {value}
                </LedgerCell>
              </LedgerRow>
            ))}
          </Ledger>
        </Demo>
        <Demo
          name="<RecordList> · groups, more, fold"
          note="Group headings with counts, a closing +N more, one folded line for absent results."
        >
          <RecordPrimitivesDemo />
        </Demo>
        <Demo
          name={'<RecordList variant="timeline">'}
          note="Activity: kind-coloured dots on a rail, a heading per household day, rows print only their time."
        >
          <ActivityTimelineDemo />
        </Demo>
        <Demo
          name={'<RecordList state={{ status: "pending" }}>'}
          note="Placeholder rows at the loaded height."
        >
          <RecordList state={{ status: "pending", rows: 3 }} />
        </Demo>
        <Demo
          name={'<RecordList state={{ status: "error" }}>'}
          note="A failed read never reads as empty."
        >
          <RecordList
            state={{
              status: "error",
              title: "Could not load connections",
              error: new Error(
                "SQLSTATE 57014: canceling statement due to statement timeout",
              ),
              onRetry: () => {},
            }}
          />
        </Demo>
        <Demo name="<RecordList empty>" note="A loaded list with no rows.">
          <RecordList empty="No purchases recorded for this product." />
        </Demo>
      </DemoGrid>
    </Stack>
  );
}
