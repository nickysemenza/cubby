# ADR 0015: `@me` is a value of every Ledger Party filter

Status: Accepted.

## Context

Declared saved views are shared by every member, but some mean "mine": My
tasks, My stuff, Wardrobe. Task carried a dedicated boolean, `assignedToMe`,
resolved inside the Task repository from an actor threaded through every list
call. Repeating that per entity would add one boolean, one repository branch,
and one actor parameter for each person-valued filter (Inventory owner, Image
captured-by, Run, Device, Vendor Account), and a saved view could not say "me
or this other member".

## Decision

- `CURRENT_MEMBER_FILTER` (`@me`) is a valid value of every Ledger Party
  filter. The generator emits `partyFilterList` for those filters, so the
  published filter schema, the web URL codec, and native filter state accept
  it alongside shortcodes, and both clients offer it as a "Me" option.
- Declarations, URLs, and native state keep the token itself. Only the server
  resolves it: the entity kernel's list paths (full, progressive base and
  enrichment, summary) and the few task reads outside the kernel (board,
  timeline, chart data, actionable) call `resolveCurrentMemberFilters` before
  any repository runs. Repositories never see `@me` and need no actor.
- An actor with no linked member resolves to `UNRESOLVABLE_ENTITY_FILTER` and
  matches nothing. Dropping the value would widen "mine" into everyone's.
- `assignedToMe` is deleted; My tasks is `assigneeId: [@me]`.

## Consequences

- A saved view stays active and portable: each member applying it gets their
  own rows, and choosing another member visibly leaves the view.
- New person-valued filters get `@me` from their declaration alone.
- A read path that bypasses both the kernel and the task handlers would pass
  `@me` to a repository, where it resolves no shortcode and matches nothing;
  such a path must call the resolver.
