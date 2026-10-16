# ADR 0018: `@me` is a declared value of Ledger Party filters

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

- `CURRENT_MEMBER_FILTER` (`@me`) is a valid value of each declared Ledger Party
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
- Amended (#2409): a filter opts in with `currentMember: true` on its
  descriptor rather than by being a Ledger Party filter, so the token set a
  filter accepts is declared beside its other tokens (Any value, No value,
  Match all). The Work queue's `waitingFor` is an any-of that accepts `@me`
  (work routed to me or Either) beside `either` and member codes, with No
  value for unresolved items.

## Consequences

- A saved view stays active and portable: each member applying it gets their
  own rows, and choosing another member visibly leaves the view.
- New person-valued filters get `@me` from their declaration alone.
- A read path that bypasses both the kernel and the task handlers would pass
  `@me` to a repository, where it resolves no shortcode and matches nothing;
  such a path must call the resolver.
