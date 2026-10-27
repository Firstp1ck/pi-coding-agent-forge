# VBA capability threat model and design boundary

Status: updated 2026-10-16 for 0.2.0. `ooxml-safe` still never parses or changes VBA. Separate Windows-only tools (`workbook_vba_read`, `workbook_vba_edit`) list and edit VBA modules through desktop Excel under the boundary in *User-authorized VBA module editing* below. Execution remains prohibited.

## Assets

- Workbook confidentiality and integrity.
- Byte identity of VBA projects, signatures, ActiveX, embeddings, custom UI, and associated relationships/content declarations.
- Host integrity, user Excel processes, certificate stores, and Office Trust Center policy.
- Agent and model context, which must not receive unrequested VBA source or secrets.

## Adversaries and failure modes

- Malicious `Workbook_Open`, `Auto_Open`, event, DDE, XLM, link, Power Query, or connection payloads.
- Parser confusion from non-canonical relationship targets, malformed compound files, oversized streams, encryption, or signature structures.
- Accidental signature invalidation or active-part loss during save.
- Prompt injection embedded in module names, comments, source text, or forms.
- Password, certificate, or source leakage through logs, snapshots, errors, and tool details.
- Native automation attaching to or terminating an unrelated Excel process.

## Current boundary

`ooxml-safe` may report:

- presence, path, size, content type, relationship provenance, and SHA-256 of protected VBA/signature parts;
- whether the package advertises macro-enabled content;
- that module/reference/project-protection metadata is unavailable with the selected backend.

It does not parse MS-OVBA streams, expose source, request passwords, execute macros, alter signatures, or transplant active parts. The read-only metadata task is intentionally closed as unavailable rather than approximated from untrusted binary strings.

## Preconditions for a future metadata extractor

1. A memory-safe, bounded Compound Binary/MS-OVBA parser with explicit encryption and decompression limits.
2. Independent fixtures for protected, signed, malformed, non-canonical, and multilingual projects.
3. No Excel launch and no VBA execution API.
4. Output allowlist limited to module names/types, reference identities, signature metadata, and project-protection status; source remains excluded.
5. Prompt-injection labeling and strict output truncation.
6. Fuzzing, security review, and no regression to protected-part byte identity.

## User-authorized VBA module editing (0.2.0)

The user asked for VBA editing in the same package, enabled through setup or a user-confirmed agent request. This replaces the earlier precondition that source capability must ship as a separately installed package. The remaining preconditions are met as follows:

| Earlier precondition | 0.2.0 implementation |
| --- | --- |
| Separate contract, never another `workbook_edit` operation | Two separate tools with their own schemas. `workbook_edit` and protected-part enforcement are unchanged. |
| Explicit per-run user confirmation | Session permission (setting or dialog) **and** a per-commit `ctx.ui.confirm` showing paths, hashes, operations, and code previews. No dialog-capable UI → `AUTHORIZATION_REQUIRED`. No parameter can grant approval. |
| Destination-only writes | New `.xlsm` only; source opened read-only and hash-checked throughout; exclusive create; never overwrite. |
| Signature invalidation warnings | Signed projects detected by relationships/content types as well as canonical filenames, and refused unless `allowSignatureRemoval` and a dialog stating signature loss. Output uses the same detection and reports `absent` or `present-unverified`. |
| Secret redaction / passwords | Locked projects refused; passwords never requested. |
| Isolated analysis, no execution | Owned hidden Excel with `AutomationSecurity=ForceDisable`, events off, manual calculation, sentinel checks; statically banned run/refresh/registry/certificate/VBE APIs. |
| Prompt-injection labeling | Read results carry `sourceIsUntrustedData: true`; tool guidelines and the skill instruct the agent to treat code as data. |
| Refresh and XLM preflight | Before any backend call in both read and edit, scan the bounded source package. Reject `refreshOnLoad="1"` / `"true"` in connections, pivot cache, or query table XML identified by path or content type. Reject relationships ending `/xlMacrosheet` or `/xlIntlMacrosheet` and content types containing `macrosheet`. |
| Saved-code verification | Worker hashes each edited module's in-memory stored code and requires an exact normalized-hash match after save/reopen. Service independently compares full saved code against the approved submission. Missing, truncated, or hash-inconsistent edited code fails closed. |

### Dialog trust boundary

Print mode has no dialog UI and cannot authorize commits (`AUTHORIZATION_REQUIRED`). RPC mode is dialog-capable: the host application answers `ctx.ui.confirm` and **must show each dialog to a person**. The extension trusts this host as the user's UI; it cannot prove a human saw the dialog or prevent a host from auto-approving. No TUI-only restriction is implemented. Settings/session permission never replace per-edit approval.

### Formatting-equivalence boundary

The service accepts an exact approved-code hash, otherwise only this textual equivalence: normalize line endings; trim each line, collapse runs of spaces/tabs, compare case-insensitively; ignore blank leading/trailing lines and one leading `Option Explicit`. A tolerated difference produces a warning and includes `approvedCodeSha256` and `storedCodeSha256` in operation summaries. Other differences fail `VALIDATION_FAILED` before output publication. This allows VBE formatting without allowing arbitrary changed code, but is not semantic VBA analysis: case/spacing inside literals and comments are also normalized, and `Option Explicit` can affect semantics. Review saved source and warnings rather than treating equivalence as proof of unchanged behavior.

Accepted risks (user decisions):

- Excel's full save may change unrelated workbook parts. These are reported (`unrelatedChangedParts`), not prevented.
- Real-Excel acceptance is waived for 0.2.0; behaviour is verified only against a simulated backend until `npm run test:vba` passes on Windows.
- Code is limited to ASCII to avoid codepage corruption in the VBA editor.

## Preconditions for source extraction or replacement (original design, superseded where noted above)

Source capability must be a separately installed package and contract. It requires explicit per-run user confirmation, destination-only writes, secret redaction, provenance, signature invalidation warnings, signer/certificate design, isolated analysis, and a fresh legal/security review. It must never be added as another `workbook_edit` operation.

## Execution remains prohibited

No default or optional code in this package may call `Application.Run`, enable macros/events, lower Trust Center policy, install certificates, or refresh external data. Any future executor requires a separate sandboxed product, disabled by default, with explicit confirmation on every run.
