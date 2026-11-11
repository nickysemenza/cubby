# GitHub backlog

[GitHub Issues](https://github.com/nickysemenza/cubby/issues) owns unfinished
work. Repository documentation owns behavior and decisions; do not keep a
second backlog in Markdown. An issue is a proposal until the implementation and
validation establish otherwise.

## Labels and Status

Classify issues with labels. Discover names with
`gh label list --repo nickysemenza/cubby`.

| Label         | Meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `area:*`      | Affected domain or platform; add one per area.                       |
| `bug`         | A defect. Investigating a reported defect is still a bug.            |
| `operational` | A household data pass rather than a code change.                     |
| `parked`      | Open but out of triage. A comment names the trigger that revives it. |

The [Cubby Project](https://github.com/users/nickysemenza/projects/2) tracks
one field, Status: Inbox, Todo, In progress, Verify, Done. New and reopened
issues are added automatically; new issues start in Inbox, and closing an issue
sets Done. Move an accepted issue to Todo and set In progress when
implementation starts. Use Verify only when an issue needs acceptance after
deployment.

Park an issue when it is wanted but nobody will act on it until something
changes: add `parked` and comment with the trigger (a release, a measurement, a
member decision). Remove the label when the trigger occurs.

One independently finishable outcome belongs in one issue. Its body holds the
outcome, constraints, acceptance criteria, blockers or waiting trigger, and the
validation needed. Use subissues for independently deliverable steps and native
Blocked by relationships for real prerequisites; read the parent when working a
subissue. Similar symptoms alone do not establish a duplicate or a blocker; use
native Relates to when containment, dependency or common cause is unproven.

## Agent workflow with gh

Before implementation, search open issues using the requested outcome, affected
feature, component, or error. Read plausible matches, their acceptance criteria
and native relationships. For a crash, runtime error, runtime regression, or
supplied Sentry reference, also check the relevant
[Sentry issues](../runbooks/sentry-triage.md) and their GitHub links. A related
issue does not expand the authorized scope.

```sh
gh issue list --repo nickysemenza/cubby --search "<terms>"
gh issue view <number> --repo nickysemenza/cubby \
  --json number,title,state,labels,parent,subIssuesSummary,blockedBy,blocking
```

Create an issue only for work that will not start now; work that begins in the
current session, or a remainder the member is doing next, needs no issue,
because its PR body or done report carries the outcome. Record any other
deferred remainder in an issue (new or existing) when the PR lands. Search for
the same outcome first and update the existing issue when it matches. Read live
code before copying an old issue's path or architecture.

```sh
gh issue create --repo nickysemenza/cubby --title "<title>" \
  --body-file <file> --label area:<area>
gh issue edit <number> --repo nickysemenza/cubby --add-label parked
gh project item-edit 2 --owner nickysemenza --url <issue-url> \
  --field Status --value "In progress"
```

Pass issue text through body files or structured arguments, not shell
interpolation. For native relationships use `gh issue create --parent <number>`
or `--blocked-by <numbers>`, and `gh issue edit <number> --parent <n>` or
`--add-blocked-by <n>` on existing issues; remove obsolete relationships
explicitly. Relates to has no CLI flag:
`gh api -X POST repos/nickysemenza/cubby/issues/<number>/relates_to -F issue_id=<id>`,
where `<id>` is the target's internal id from
`gh api repos/nickysemenza/cubby/issues/<n> --jq .id`, not its number.

Attach synthetic screenshots or short reproduction videos with `--attach` on
`gh issue` or `gh pr` create, edit and comment, referencing a local path from a
body file. Uploads are limited to 10 MB per file. Follow
[PR screenshots](validation.md#pr-screenshots); never upload live household
evidence.

## Closing issues

Before opening the PR, compare the implemented outcome and validation against
the matched issues' acceptance criteria.

- A PR that completes an issue says `Fixes #<number>` in its body so the merge
  closes it. Use `Related to #<number>` for partial or supporting work.
- A change that supersedes or makes an issue obsolete closes it in the same
  change, as not planned, with a one-line reason or replacement link.
- Close a genuine duplicate with
  `gh issue close <number> --duplicate-of <canonical>`, after moving useful
  evidence to the canonical issue.
- An issue in Verify gets a plain reference in the PR and closes after the
  post-deploy check passes.
- An operational pass closes on verified outcomes; it needs a PR only when code
  or docs changed.

Closing a parent does not complete its open subissues. Not-planned and duplicate
closures are not deliveries, even though the Project shows them as Done.

## Public content

Repository issues are public even though the Project is private. Use synthetic
engineering examples and keep raw household evidence, live entity identifiers,
and diagnostics in their authenticated source systems. Preserve functional
links. Operational issue updates describe verified outcomes without publishing
household records.
