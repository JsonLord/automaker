# Gate 02 — shared project filesystem truth

Start SHA: `22baff39cac6c1c8665eb59132fb5bf6fac579c4`. End SHA is in the gate ledger.

project-inspection.ts is a common read-only physical directory inspector. The
Argus guard retains its registration/identity lookup and then applies the same
root, permissions, directory-type and metadata-symlink facts used by overview.
No missing directories or metadata are created; stale registrations remain intact.
Feature inspection reads bounded regular JSON files without FeatureLoader's
recovery/auto-restore writes. Counts are complete only when featureCountsKnown=true.
Compatibility numeric counts represent observed partial data, not asserted totals;
featureState and aggregate featureCountsComplete/incompleteProjectCount make that
explicit. Unavailable and unknown projects count as errors rather than idle.

| Fixture                                 | Overview reason/state                  | Argus access                 |
| --------------------------------------- | -------------------------------------- | ---------------------------- |
| Valid registered/nested directory       | available                              | physical path                |
| Missing path                            | PROJECT_PATH_MISSING                   | 404                          |
| Denied directory                        | PROJECT_DIRECTORY_DENIED               | 403                          |
| Inaccessible parent                     | PROJECT_PARENT_INACCESSIBLE            | 403                          |
| File replacing directory                | PROJECT_NOT_DIRECTORY                  | 404                          |
| Broken symlink                          | PROJECT_BROKEN_SYMLINK                 | 404                          |
| Outside physical root                   | PROJECT_OUTSIDE_ALLOWED_ROOT           | 403                          |
| .automaker symlink                      | ARGUS_METADATA_SYMLINK_REFUSED         | 403                          |
| Stale or mismatched registration        | unavailable if missing                 | registered identity rejected |
| Missing/corrupt/unreadable feature JSON | unknown/incomplete, counts not known   | ownership guard unchanged    |
| Mixed three-project overview            | 1 idle, 2 errors, incomplete aggregate | no project creation          |

Actual result: 22 tests passed across common inspection and existing Argus mode
integration (exit 0); server/package build passed. A fixture originally normalized
its traversal string with path.join; the test was corrected to submit literal ..
segments, without weakening production path validation. Raw errors are not returned
in overview failures. The real server retains authentication ahead of overview.
Acceptance PASS; proceed to Gate 03. Image proof remains a separate open gate.
