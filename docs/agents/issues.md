# GitHub backlog

[GitHub Issues](https://github.com/nickysemenza/cubby/issues) owns unfinished
work. The [Cubby Project](https://github.com/users/nickysemenza/projects/2) owns readiness, work type, priority, and delivery status;
read those fields as well as the issue body before selecting work. Repository
documentation owns behavior and decisions. An issue is a proposal until the
implementation and validation establish otherwise; do not maintain a second
editable backlog in Markdown.

## Fields and selection

| Field     | Values and meaning                                       |
| --------- | -------------------------------------------------------- |
| Readiness | Ready; Needs schema plan; Needs decision; Waiting; Later |
| Work type | Bug; Feature; Maintenance; Investigation                 |
| Priority  | High; Medium; Low                                        |
| Status    | Inbox; Todo; In progress; Verify; Done                   |

Readiness names the next blocker, independently of priority and delivery status.
Ready means the outcome is decided and needs no schema planning. An unresolved
decision or missing evidence takes precedence over an eventual schema change.
Waiting requires a named trigger in the body; Later parks wanted work until
there is a concrete reason to promote it. Check native Blocked by relationships
and parent constraints before starting even a Ready item.

Choose Work type by the primary outcome: repair is Bug, added capability is
Feature, cleanup/performance/infrastructure is Maintenance, and evaluation with
no committed repair is Investigation. Investigating a reported defect remains
Bug. High priority means crashes, integrity failures, blocked core workflows,
or explicitly urgent capability; Medium means useful near-term improvements or
defects with workarounds; Low means optional polish or longer-term work.
Reassess when impact changes. Waiting can still be High priority.

Use `area:*` labels for domain/platform filtering and `operational` for household
data passes. Do not duplicate the Project fields as labels or title emojis.
One independently finishable outcome belongs in one issue. Keep supporting
constraints and acceptance criteria in its body; use subissues for independently
deliverable steps and native dependencies for actual prerequisites. Read the
parent issue when working a subissue. Preserve explicit sequencing and triggers;
do not infer a dependency just because two issues mention the same domain.

## Project views and automation

Backlog is the open-work table, grouped by Readiness and sorted by Priority.
Ready is the Todo/Ready board, with Work type columns and Priority swimlanes.
Delivery uses Status columns and Priority swimlanes. Intake catches open issues
in Inbox or missing any of the three metadata fields. These are views of the
same issues, not separate backlogs.
Intake uses `is:issue is:open (Status:Inbox OR no:Readiness OR no:work-type
OR no:Priority)`; multiword field keys use hyphens in Project filters.

Native workflows auto-add new or updated open repository issues, put new items
in Inbox, set closed items to Done, and return reopened items to Todo. Marking
Done also closes the issue through the native Auto-close issue workflow. Closed
issues inactive for two weeks are archived from the Project; archiving preserves
metadata and does not delete repository issues. Explicitly add existing issues
when importing: auto-add does not backfill them. Keep PRs linked to their issue
rather than adding duplicate PR cards.

## Agent workflow with gh

Authenticate with repository access and the `project` scope. List issues with
`gh issue list --repo nickysemenza/cubby`; read an issue with `gh issue view`.
Use `gh project item-list 2 --owner nickysemenza --limit 500 --format json` with Project number `2` to read its fields. Project metadata belongs to the Project and
is not guaranteed to appear in an issue-only API response.

Before creating work, search open issues for the same outcome. Use a concise
title, outcome/context links, constraints, acceptance criteria, blockers or
waiting trigger, and the validation needed. Read live code before copying an
old issue's path or treating historical backlog context as current architecture.
Create with `gh issue create --repo nickysemenza/cubby --body-file <file>`;
attach it with `gh project item-add 2 --owner nickysemenza --url <issue-url>`
and fill the three metadata fields. New untriaged
work starts in Inbox; accepted backlog work is Todo. Move to In progress when
implementation starts. Prefer structured CLI arguments or body files over shell
interpolation of issue text.

Use `gh project item-edit 2 --owner nickysemenza --url <issue-url>
--field Readiness --value Ready` to change one field; repeat for other fields.
For native relationships, use `gh issue create --parent <number>` or
`--blocked-by <numbers>`, or the corresponding issue-edit commands. Keep updates
on the existing issue rather than creating a parallel task.

Link the implementing PR with `Fixes #<number>` for work accepted on merge to
the default branch. Include focused validation evidence. Only use Verify when
the issue explicitly needs acceptance after deployment; use a plain issue
reference in that PR and close the issue after verification instead of promising
automatic closure. Completing a household operational pass needs verified
outcomes, not a PR unless code or docs changed.

Close abandoned or superseded work as not planned, with the reason or replacement
link. Wanted-but-deferred work stays open with Readiness Later. Closed is the
issue's state; Done is a Project status. Do not count not-planned closures as
delivered work merely because their Project status is Done. Closing a parent
does not establish that its open subissues are complete. Git history and closed
issues preserve completed work; remove completed plans/reports after moving
durable facts into their owning documentation.

## Sentry and public content

Preserve every related Sentry issue identifier as a clickable Sentry URL. Related
symptoms can share an issue without asserting a common root cause or merging
their Sentry histories. GitHub closure on merge does not prove deployment and
does not resolve Sentry: resolve a Sentry issue only when an identifiable deployed
fix addresses its failure. No recent events is not evidence of a fix.

Sentry Developer does not provide the paid native tracker linking/status sync.
Agents can read Sentry through the existing integration and update GitHub through
`gh`; links are the connection, and no custom synchronizer is required.

Cubby's repository issues are public even when the Project is private. Use
synthetic engineering examples and keep raw household evidence, live entity
identifiers, and diagnostics in their authenticated source systems. Preserve
functional links. Operational issue updates describe verified outcomes without
publishing household records.
