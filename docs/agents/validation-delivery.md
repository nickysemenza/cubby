# PR, CI, and device acceptance

Inspect CI logs and annotations before editing. Fix only change-caused failures;
report flakes, infrastructure, and unavailable checks separately. Use an
isolated worktree when maintenance must not alter the configured checkout.

GitHub Actions verifies every PR and `main` push. Observe required checks on
the exact final head before merge; a green earlier commit is not evidence for a
later one. Validate deploy-only steps against CI token scopes because PR jobs do
not exercise them. Prefer a fresh branch after a squash merge.

Playwright CI covers desktop Chromium only. For changes to phone-web layout or
interaction, check the affected workflow in phone-width Safari. Require a
physical iPhone Safari pass before merge when a change depends on device
behavior: safe areas, touch gestures, keyboard or focus behavior, or browser
permissions. The web app is not installable; native fieldwork (scan, recount,
sweep, location photo pass) is validated on a device through the app. Record the device, modes, affected workflow, observation, and remaining
gap for that pass. Desktop browser and simulator tests do not sign off those
device-dependent behaviors.

Apply the [repository privacy rule](../../AGENTS.md): use synthetic data in
repository content and outward-facing engineering text, keep personal/household
information, real entity records/identifiers, and private source material out,
and preserve functional public links.
