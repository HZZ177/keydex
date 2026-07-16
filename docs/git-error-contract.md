# Git error and observability contract

`backend/app/git/error_contract.py` is the backend source of truth. `desktop/src/renderer/features/git/errorPresentation.ts` is the exhaustive Chinese UI mapping. A cross-language test compares both code sets; adding an emitted literal `GitApiError` or `GitRemoteFailure` code without updating the contract and presentation fails the gate.

| Backend code | HTTP | Runtime/UI behavior | Operation log and help |
|---|---:|---|---|
| `git_invalid_request` | 400 | Do not retry; correct the action payload. | Preserve sanitized diagnostic. |
| `git_access_denied` | 403 | Review project/repository grant. | Never suggest widening access implicitly. |
| `git_ancestor_not_authorized` | 403 | Require explicit exact ancestor grant. | Link the user back to repository authorization. |
| `git_repository_not_found` | 404 | Refresh discovery/refs/history and select again. | No blind retry against the stale target. |
| `git_operation_conflict` | 409 | Refresh, re-preview and obtain a new confirmation. | Old confirmation tokens are invalid. |
| `git_validation_failed` | 422 | Correct the path/ref/options; no automatic retry. | Show safe validation detail. |
| `git_cancelled` | 499 | Treat cancellation as terminal for that operation. | Record cancellation and duration. |
| `git_unavailable` | 503 | Repair/install system Git first. | Do not silently downgrade to another Git implementation. |
| `git_timeout` | 504 | Retry only after checking repository/network responsiveness. | Process tree must already be terminated. |
| `git_failed` | 500 | Unknown Git failure; inspect before retrying. | Copy only redacted diagnostics. |
| `git_credentials_missing` | 401 | Configure credentials outside the non-interactive command. | Never expose credential/token content. |
| `git_credential_helper_failed` | 502 | Repair/sign in to system helper, then retry. | Keep helper name and sanitized failure. |
| `git_host_key_failed` | 409 | Verify fingerprint outside Keydex and update `known_hosts`. | Never suggest bypassing host verification. |
| `git_network_unavailable` | 503 | Safe remote operations may retry after network checks. | Show remote/proxy/VPN help. |
| `git_parse_failed` | 500 | Stop unsafe interpretation; report Git version/output shape. | Provide sanitized diagnostic copy. |
| `git_output_too_large` | 422 | Narrow revision/path/line scope. | Do not truncate into a falsely successful result. |

HTTP runtime errors retain `code`, `message`, `retryable`, `details`, and status. UI alerts use the Chinese presentation title and help action while retaining the backend's safe detail. Operation logs retain code, command, repository, risk, timestamps, duration, retryability, sanitized result, and sanitized error. Unknown future codes deliberately receive a non-retryable fallback and are caught by contract tests once emitted by backend source.
