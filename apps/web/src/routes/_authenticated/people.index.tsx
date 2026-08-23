import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import {
  CreateDialogAction,
  createDialogSearchField,
} from "~/app/_components/forms/create-dialog-action";
import { PersonList } from "~/app/people/person-list";
import { Page } from "~/components/page/Page";
import { personCaptureRequest } from "~/entities/editing/editor-requests";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import { pageTitle } from "~/lib/page-title";
import { urlEnumListParam, urlStringParam } from "~/lib/search-params";

export const personSearchSchema = z.object({
  ...entityFilterSearchFields("person"),
  q: urlStringParam,
  kind: urlEnumListParam(z.enum(["household", "guest"])),
  linkedUser: urlEnumListParam(z.enum(["has", "none"])),
  ...tableSearchFields,
  ...createDialogSearchField,
});
const searchDefaults = { q: undefined, create: undefined } as const;
export const Route = createFileRoute("/_authenticated/people/")({
  validateSearch: personSearchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: () => (
    <Page
      variant="list"
      listChrome="workbench"
      title="People"
      entity="person"
      layout="full"
      actions={<CreateDialogAction request={personCaptureRequest()} />}
    >
      <PersonList />
    </Page>
  ),
  head: () => ({ meta: [{ title: pageTitle("People") }] }),
});
