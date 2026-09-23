# Entity defaults across surfaces

Status: **in progress**. The related-image preview fix shipped in #1288. This
follow-up makes the entity compiler supply ordinary behavior everywhere an
entity appears, with explicit omissions and ordering overrides for exceptions.
An entity declares its supported capabilities once; the compiler does not
infer write availability from the mere presence of a schema or repository
method.

Declaration inputs that replace inferred values use explicit `Override` names
(`defaultOverride`, `directionOverride`, `sectionOverrides`,
`actionOverrides`, `viewOverrides`, `displaySourceOverrides`). Omission selects
the default; an empty collection opts out where the schema permits it. The
generated manifest retains ordinary resolved names. This naming rule extends
to field-level fallbacks as those defaults become universal.

## Current boundary

The 27 declarations already generate contracts, routes, manifest data, native
descriptors, editor metadata, and relation tables. They still repeat many
presentation and availability decisions: field list/detail membership, sort
rosters and defaults, search flags, routes, and related-image sources. Web and
native then each have specialized registries and projections. A declaration
being present does not prove that a list projection contains a field or that a
repository can sort on it.

There are two compilation paths, `loadEntityDeclarations` and
`compileEntityDeclarations`. They must run the same defaulting and validation
passes; only the loader additionally checks source modules and browser files.

## Effective entity policy

Compile each declaration to one effective specification before generating any
client or server artifact. Each default has three parts: an eligibility test
from declared facts, a deterministic rank, and an explicit override or omission.
The effective specification is what web, native, HTTP, MCP, and the repository
scaffold consume. The compiler rejects overrides that name unavailable fields,
relations, actions, or sources.

| Aspect             | Default basis                                                                                   | Exception                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Read surfaces      | Available list/detail projections, readable field kinds, title and field order                  | Per-field hide, format, renderer, order, and section        |
| List sort          | Stored sortable columns and repository-supported computed sorts; rank date and title candidates | Default key, direction, rank, or explicit field roster      |
| Related images     | Owned media first, then direct Image reference, then single outgoing image-storing subject      | Omit relation, priority, ordering, or all borrowed images   |
| Relations          | Declared and derived inverse edges; generic detail tables and prefill                           | Omit with reason, custom section, order, filter, or prefill |
| Routes and actions | Available read contract and declared capabilities                                               | Route/verb override or omission                             |
| Search             | Search projection and indexing contract                                                         | Enable/disable and ranking override                         |
| Editor             | Writable field roster and control metadata                                                      | Section, order, control, or intent override                 |

The image ranking never recursively borrows another entity's `displayImages`.
An activity relation is insufficient evidence for a subject preview: a member's
meal photos, for example, should not become that member's portrait. Relations
below the eligibility cutoff need an explicit promotion. Multiple eligible
sources remain fallbacks in rank order, so a missing preferred image can still
fall through to the next one.

Storage columns, Zod contracts, SQL predicates, repository transactions,
relationship mutation semantics, image identity evidence, and supported
capabilities remain declared facts. A UI default cannot create a writable
field or a repository operation. An explicit capability drives the matching
actions and transports everywhere by default; an edge case declares an
override or omission once, with compiler validation. The declaration should
not repeat standard web, native, HTTP, and MCP switches for the same action.

## Migration and delivery

The first compiler pass now resolves ranked related images, sort defaults,
Overview sections, default actions and views, card subtitles, editor section
fallbacks, and routine list/detail/create routes. Existing generated data is
semantically unchanged; the declaration files now contain fewer repetitions.
The remaining steps widen the default to field visibility, search, and
operation availability across all consumers. Those require projection and
action-handler coverage checks before changing the resolved catalog.

1. Add one shared effective-specification pass and use it in both compiler
   entry points. Keep defaults in the compiler, never in a web or native
   renderer. Compare effective output with today's generated catalog before
   deleting declarations.
2. Establish list/detail field availability from their actual projections.
   Make unreadable or unsupported renderers ineligible and report a compiler
   error when an override requests them. Default generic fields and sections,
   then convert intentional absences into explicit omissions.
3. Derive sorting, search, routes, actions, and image sources from the same
   facts. Preserve domain-specific ordering as small overrides. Audit the
   resulting behavior change on every entity, including entities with no
   storage, a custom list, or no generic detail page.
4. Regenerate the TypeScript manifest, browser routes and bindings, OpenAPI,
   Swift catalog and client. Verify representative web table, card, detail,
   and native list/detail/editor behavior; check that a new ordinary entity
   needs only domain facts and that an opt-out works on both platforms.
5. Run focused compiler and behavior tests, appropriate type/build checks,
   then GitHub checks on the exact final PR head before merge.

The main agent owns implementation and validation in this checkout. No schema
migration or production data repair is expected. If a default exposes a new
read or write operation, revisit that claim and its deployed-code compatibility
before delivery.
