# Detail workspaces across web and Apple

Status: native details retained; exactly one hosted Run evidence pilot authorized.
The earlier full-cutover decision is superseded. Merge remains subject
to the required client and exact-revision CI gates.

## Confirmed direction

- Use the Work surface composition across all entity detail pages, including
  embedded lists and reports on web, iOS, and macOS.
- Lead with essentials: identity, condition or outcome, useful facts, relevant
  relationships, and next actions. Keep complete evidence and secondary
  metadata directly reachable in focused views.
- Preserve Field Guide's warm surfaces, serif record identity, domain colors,
  and restrained motion. Improve hierarchy, alignment, and use of width;
  reduce nested boxes and repeated section chrome.
- Apple details need a substantial density improvement. Preserve native hit
  targets and Dynamic Type; reduce surrounding chrome rather than shrinking
  interaction targets.
- Retain native detail ownership. Experiment with exactly one hosted view:
  Run evidence (transcript, logs and AI usage).
- Load the hosted web surface with web app navigation omitted. Native owns
  record links, capture, sharing and Back/selection history.
- Judge the experiment by shared implementation benefits and the Apple
  experience together. Broad hosted detail adoption is outside this change.

## Implementation contract

All entity details remain native in iOS/macOS. Improve their density through
shared native rendering. Improve browser details through the declaration-driven
Work surface. Exactly one view is hosted experimentally: Run evidence, covering
transcript, logs and AI usage. Native Run overview, actions, capture and all
other entity details remain intact. Do not delete native detail/report renderers
or weaken their coverage on behalf of this experiment.

The shared composition uses a compact identity and a small set of useful record
views. Overview leads with condition/outcome and relevant facts. Work exposes
connected records and declared commands. Evidence holds logs, provenance and
technical metadata. A section or slot's optional `workspace` declaration owns
its grouping; relations default to Work and timelines to Evidence. Availability
follows declarations and loaded content. Wide surfaces use a compact left index;
phone surfaces use a horizontal view strip. Switching grouped views preserves
mounted draft state. Reuse PR #1886's ledger for stage and log rows.

The native session bootstrap is POST `/api/native-workspace/session`. It verifies
the signed bearer independently of ambient browser cookies and returns the
configured HttpOnly browser session cookie without caching. Native installs it
in an isolated nonpersistent WebKit store before opening the hosted record.
The credential and host revision guard late responses; logout or host changes
discard the store and restoration state. Credentials never enter JavaScript.

Run entry routes retain `nativeWorkspace=run-evidence` through canonical redirects and omit
web app navigation chrome. The hosted surface renders only Evidence, without
Overview/Work navigation or record hero commands. The flag has no effect on other
entities. Native owns cross-record links, imperative record
navigation and its Back/selection history. Web owns views, hashes, drafts and
inline commands. The version-1 main-frame bridge validates the exact configured
origin; it supports ready, navigate, changed, authRequired and updateRequired.
Native writes invalidate hosted queries through `cubby-workspace-refresh`.
[The bridge contract](../../apps/apple/DESIGN.md#run-evidence-pilot) owns native details.
The global Apple compatibility gate covers hosted documents and server functions
as well as HTTP operations. The pilot adds no breaking existing native contract.

Validate synthetic Product, Run and Project records across web, iPhone and
macOS. These cover ordinary facts and editing, dense reports and evidence,
and connected tasks/spending. They are acceptance probes for shared detail density. Run evidence alone is the
embedded experiment; Image and Recipe remain native.

### Acceptance evidence

- Existing native sign-in opens the hosted workspace without another login.
  Host changes, logout, expired sessions, and server-required client updates
  have defined behavior. Credentials never pass through page URLs or ordinary
  JavaScript messages.
- Opening a related record uses native routing. Back and Mac history return
  to the prior record and its selected view/scroll position. Ordinary web
  routes retain their web navigation behavior.
- Inline edits and workflow commands retain drafts and display server errors.
  Successful writes refresh the relevant native context; a view change does
  not discard input. Native capture and sharing still act on the correct
  record.
- The work surface has one clear scrolling owner and no duplicate app chrome.
  Keyboard focus, the on-screen keyboard, safe areas, text scaling, VoiceOver,
  appearance, and phone-sized action targets work in the embedded surface.
- Initial loading, same-record refresh, unavailable network, page-load failure,
  and web-process termination expose usable recovery. Measure cold and warm
  opening on the same synthetic records against existing native detail;
  record observations rather than inventing a performance claim.
- A shared UI change reaches web and embedded workspaces without a parallel
  Swift detail implementation. Native/web bridge incompatibility has explicit
  detection and recovery; hosted deployment does not silently break installed
  apps.

## Completion and constraints

Deliver one ready PR with an independent final-diff review, scope evidence,
focused web regressions, Apple host tests, simulator and TestFlight builds,
and the server version-gate result. List missing checks honestly. Required CI
must pass for the final PR content before merge. The HTML proposals establish
composition intent; they are not acceptance evidence for the implementation.

Keep household data, source evidence, raw diagnostics, available actions and
relationships intact. Keep one declaration spine. Use synthetic records in
repository content and validation artifacts. No database migration or data
reset is part of this UI cutover. The hosted workspace keeps the existing
network requirement. Measure performance rather than promising improvement.
