# ADR 001: One engineering scheduler, separate infrastructure and execution

Status: accepted for this implementation; live integrations require the verification plan.

`ArgusAutonomyRunner` alone advances projects, schedules wakes, dispatches Jules,
and invokes Milestones D/E. Campaigns persist deadlines and budgets; they have no
execution loop. Scout proposes work and requests Manager admission. The board is a
projection, and generic card changes cannot admit, execute, approve, or merge Argus work.

Manager owns admission and objective decisions. Planner decomposes admitted work.
`ARGUS.md` remains the stable objective; `spec.md` is the renewable campaign brief.
Jules is the default remote builder. OpenCode provides bounded review/diagnosis;
local implementation is unavailable without a trusted isolated executor.

Foreman manages infrastructure only. Its optional adapter reads approved host IDs
through API v2. It does not plan engineering, provision or destroy hosts, expose
shells, or run an independent scheduler. Static and mock providers implement the
same durable worker lease boundary. Foreman failures have no effect on ordinary Jules dispatch.
No Foreman GPL implementation or restricted Loki implementation is vendored.

Repository-scoped GitHub tag claims serialize merges across server instances.
Ownership, exact candidate HEAD, current base, integration CI, strict branch
protection, Senior review, and required Loki proof are checked before merging.
Unknown or expired ownership is never stolen. This deliberately trades automatic
recovery speed for avoiding concurrent or duplicate remote side effects.

Untrusted verification belongs on external isolated workers with no control-plane
secrets or privileged Docker socket. An unavailable worker is unavailable evidence.
A timer firing, a passing unit mock, or an installed binary is never proof of a live integration.
