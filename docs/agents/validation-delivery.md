# PR, CI, and device acceptance

Inspect CI logs and annotations before editing. Fix only change-caused failures;
report flakes, infrastructure, and unavailable checks separately. Use an
isolated worktree when maintenance must not alter the configured checkout.

GitHub Actions verifies every PR and `main` push. Observe required checks on
the exact final head before merge; a green earlier commit is not evidence for a
later one. Validate deploy-only steps against CI token scopes because PR jobs do
not exercise them. Prefer a fresh branch after a squash merge.

For phone navigation labels, ordering, badges, and ordinary links, verify the
phone-width layout and interaction with browser tests, then use WebKit CI as the
merge gate. Require a physical iPhone Safari and installed-PWA pass before
merge when a change depends on device behavior: safe areas, touch gestures,
keyboard or focus behavior, browser permissions, or installed-PWA launch,
return, and navigation history. Record the device, modes, affected workflow,
observation, and remaining gap for that pass. WebKit and simulator tests do
not sign off those device-dependent behaviors.

Apply the [repository privacy rule](../../AGENTS.md): use synthetic data in
repository content and outward-facing engineering text, keep personal/household
information, real entity records/identifiers, and private source material out,
and preserve functional public links.
