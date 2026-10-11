# PR, CI, and client acceptance

Inspect CI logs and annotations before editing. Fix only change-caused failures;
report flakes, infrastructure, and unavailable checks separately. Use an
isolated worktree when maintenance must not alter the configured checkout.

GitHub Actions verifies every PR and `main` push. Observe required checks on
the final head before merge; a pass replayed from the shared Nx cache for the
same content counts, but a green earlier commit with different content is not
evidence for a later one. Validate deploy-only steps against CI token scopes because PR jobs do
not exercise them. Prefer a fresh branch after a squash merge.

Client verification uses Apple host tests, a simulator build, a TestFlight
build, and the server version-gate test. An automated phone-width browser check
may supplement these for web layout and interaction. Manual device verification
is never a merge requirement, including for device-dependent behavior or native
fieldwork.

Apply the [repository privacy rule](../../AGENTS.md): use synthetic data in
repository content and outward-facing engineering text, keep personal/household
information, real entity records/identifiers, and private source material out,
and preserve functional public links.
