import { Fragment, type FC, type ReactNode } from "react";

import { Stack } from "~/ui/layout";

export interface BasicInfoField {
  label: string;
  value: ReactNode;
  /** Secondary browse/filter action kept outside editable values and links. */
  filterAction?: ReactNode;
  /** Quiet secondary line under the value (where an inherited value comes
   * from), kept off the value line so its row actions stay put. */
  caption?: ReactNode;
  hide?: boolean;
  /** Prose gets the full fact-grid width instead of a narrow value column. */
  fullWidth?: boolean;
}

interface BasicInfoProps {
  fields: BasicInfoField[];
  header?: ReactNode;
  footer?: ReactNode;
  actions?: ReactNode;
}

export const BasicInfo: FC<BasicInfoProps> = ({
  fields,
  header,
  footer,
  actions,
}) => {
  const visibleFields = fields.filter((f) => !f.hide && f.value !== undefined);

  return (
    <Stack gap="sm">
      {header}
      <dl
        className={
          // Facts grid: a real two-column CSS grid (not one grid per row) so
          // every label lines up, sentence-case secondary text rather than
          // an eyebrow, and no per-row hairline. Phone widens the label
          // column and the type a step, per DESIGN.md's fact-grid sentence.
          "basic-info-ledger grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]/[18px] max-md:grid-cols-[6.5rem_minmax(0,1fr)] max-md:gap-y-2.5 max-md:text-sm"
        }
      >
        {visibleFields.map((field) => (
          <Fragment key={field.label}>
            <dt
              data-slot="basic-info-label"
              className={
                field.fullWidth
                  ? "col-span-2 min-w-0 text-muted-foreground"
                  : "min-w-0 text-muted-foreground"
              }
            >
              {field.label}
            </dt>
            {/* A value is often one inline-flex control (an edit trigger); as a
                flex child its min-width is its content, so it has to be told
                to shrink or a long note escapes the rail. */}
            <dd
              data-slot="basic-info-value"
              className={
                field.fullWidth
                  ? "col-span-2 grid min-w-0 content-start gap-0.5"
                  : "grid min-w-0 content-start gap-0.5"
              }
            >
              {/* Row actions wrap under a value that needs the width rather
                  than truncating it — the value is what the row is for. */}
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 break-words [&>*]:max-w-full [&>*]:min-w-0">
                {field.value}
                {field.filterAction}
              </span>
              {field.caption}
            </dd>
          </Fragment>
        ))}
      </dl>
      {footer}
      {actions && <div className="pt-2">{actions}</div>}
    </Stack>
  );
};
