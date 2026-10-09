# Notification temporary-file rename ENOENT

Status: documented; not reproduced on the investigated branch.

The supplied deployed log reports `ENOENT` while renaming a notification temporary file into `.automaker/notifications.json`. That message alone does not distinguish a temporary-file collision, project directory removal, another cleanup process, a storage/mount event, or an older deployed implementation.

The investigated branch already has a module-level per-file queue around notification read/modify/write operations and a temporary name containing a timestamp plus UUID. Thus two simultaneous writes in this implementation do not share a temporary filename. The existing regression runs 20 notification creations concurrently, verifies all 20 persist, and passes.

No new mutex or retry was added: retrying an unexplained ENOENT could hide removal of the project directory. A notification fix is therefore not included in the OpenCode routing commit. Further diagnosis needs the actual deployed SHA, complete rename error paths, the nearby project deletion/cleanup timeline, and storage events. Record names and operation timing without notification bodies or credentials.
