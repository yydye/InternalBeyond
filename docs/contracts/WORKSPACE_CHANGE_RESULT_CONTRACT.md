# Workspace Change Result Contract v1

Status: canonical for Work Mode Workspace read and snapshot-change outcomes.

## Canonical value

`workspace-changed` is the canonical error code when an operation discovers that the current Workspace state no longer matches the state authorized or captured for the operation.

When the mismatch is specifically against a Work Mode authorized snapshot, operation results retain that meaning with bounded metadata:

```json
{
  "ok": false,
  "error": "workspace-changed",
  "workspaceChange": {
    "scope": "authorized-snapshot",
    "reason": "snapshot-mismatch"
  }
}
```

The metadata identifies only the kind of mismatch. It does not include file contents, content hashes, credentials, or prompt data.

## Run event projection

Workspace read failures continue through the existing DSH Host Run Event. For compatibility, its event name remains `tool-denied`; a snapshot mismatch is distinguished from a permission denial by `code: "workspace-changed"` and `reason: "snapshot-mismatch"`. Consumers present this case as a stale snapshot, not as a Consent denial. No standalone Workspace event bus or event store is introduced.

Other `workspace-changed` outcomes may omit `reason` when the existing data does not identify a more specific cause. Consumers must not infer an authorized-snapshot mismatch from the canonical code alone.

## Migration and compatibility

`workspace-changed-snapshot` is a legacy alias for the same stale authorized-snapshot outcome. New producers emit `workspace-changed` with the metadata above. Consumers normalize the legacy alias to the canonical code while retaining `scope: "authorized-snapshot"` and `reason: "snapshot-mismatch"`.

Previously retained Host progress events containing `code: "workspace-changed-snapshot"` remain readable and render as an authorized-snapshot mismatch. No event or database migration is needed.

Write-specific outcomes such as `workspace-changed-before-write` and `workspace-changed-atomic` remain distinct because they identify different optimistic-write checks.
