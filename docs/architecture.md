# Architecture

Duckit is an offline Electron application. Electron main owns all persistence,
filesystem dialogs, subprocesses, backup and synchronization. A sandboxed preload
exposes only named, validated operations. Renderer code has no filesystem,
credential, SQL or process access. Permissions and external navigation are denied.

The pure TypeScript budgeting engine uses bigint minor units internally. Shared
contracts serialize integer minor units as canonical decimal strings. Dates are
calendar strings, never instants. Currency is metadata; changing it never converts
amounts. Shared contract changes belong to the integrating maintainer.

Each production budget lives outside source control in application data. Development
and tests use isolated roots. Synthetic fixtures are the only fixtures permitted
in public source, CI output, or screenshots. Machine credentials are never part of
a budget, archive, or shared history.

Dolt owns normalized durable domain data and revisions. Commands carry a unique ID
and expected revision: retries return the original outcome; stale commands preserve
the user's input for review. Checkpoint failures must not roll back successful local
writes. Database format versions gate writes and merges.

Sync is optional, sequential, and independent of local saving and backups. Remote
privacy and immutable repository identity must be checked before every upload.
Divergence requires a reviewed complete-snapshot decision and a normal merge commit
with both parents. Restores and imports use separate validated candidates and an
atomic active-database pointer. Never force agreement with legacy cached balances.

See [capabilities](capabilities.md) for tested implementation status and
[runtime notes](runtime.md) for the bundled transport feasibility evidence.
