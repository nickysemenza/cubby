# PR, CI, and device acceptance

Inspect CI logs and annotations before editing. Fix only change-caused failures;
report flakes, infrastructure, and unavailable checks separately. Use an
isolated worktree when maintenance must not alter the configured checkout.

GitHub Actions verifies every PR and `main` push. Observe required checks on
the exact final head before merge; a green earlier commit is not evidence for a
later one. Validate deploy-only steps against CI token scopes because PR jobs do
not exercise them. Prefer a fresh branch after a squash merge.

Changes to phone navigation, safe areas, keyboard behavior, or installed-PWA
launch/return need a physical iPhone Safari and installed-PWA pass before
merge. Record device, modes, affected workflow, observation, and remaining
gap. WebKit and simulator tests are automated coverage, not device signoff.

Apply the [repository privacy rule](../../AGENTS.md): use synthetic data in
repository content and outward-facing engineering text, keep personal/household
information, real entity records/identifiers, and private source material out,
and preserve functional public links.
