# Project technical reference template

Use this template for an approved `TECHNICAL.md` companion to a project README. Before creating the file, follow the companion document consent step in `../SKILL.md`. A README request alone is not approval. This document is for advanced users, not contributors.

Adapt the sections to verified project evidence and repository-local rules. Replace placeholders, remove instructional comments, and omit irrelevant or empty sections. Do not create a file that merely repeats the README. Keep navigation links only when their destinations exist or are approved companion files that will be created and verified in the same task.

## Canonical template

````markdown
# Technical reference: {{PROJECT_NAME}}

Advanced user setup, usage, configuration, compatibility, security, and troubleshooting information.

[Back to README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

{{REFERENCE_SCOPE: describe the advanced user needs covered here without repeating the README introduction.}}

## Requirements and compatibility

| Area | Requirement or supported behavior |
| --- | --- |
| Runtime | {{VERIFIED_RUNTIME_REQUIREMENT}} |
| Platforms | {{VERIFIED_SUPPORTED_PLATFORMS}} |
| Optional services | {{VERIFIED_SERVICE_REQUIREMENTS_AND_WHEN_NEEDED}} |
| Limitations | {{VERIFIED_COMPATIBILITY_BOUNDARIES}} |

<!-- Conditional: include only user installation or enablement details beyond the README. Contributor setup, source builds, and local linking belong in DEVELOPMENT.md. Put privilege, trust, and destructive-operation warnings before affected commands. -->
## Advanced setup

{{VERIFIED_SETUP_CHOICES_AND_WHEN_TO_USE_THEM}}

```bash
{{VERIFIED_USER_SETUP_COMMAND}}
```

{{HOW_USERS_CONFIRM_SETUP_SUCCEEDED}}

<!-- Conditional: document user-facing commands and options, not API/RPC calls or tool schemas. For a skill, document useful request patterns, inputs, and outputs instead of inventing commands. -->
## Usage reference

| Command or request | Options or inputs | Result and limits |
| --- | --- | --- |
| {{VERIFIED_USER_COMMAND_OR_REQUEST}} | {{SUPPORTED_USER_OPTIONS_OR_CONTEXT}} | {{OBSERVABLE_RESULT_AND_LIMITS}} |

{{ONE_REALISTIC_ADVANCED_WORKFLOW_AND_EXPECTED_RESULT}}

<!-- Conditional: document only settings users can change. A service address or credential variable may appear when users must configure it, but never real credentials, internal endpoint catalogs, or payload examples. -->
## Configuration

| Setting or environment variable | Default | Required | Purpose |
| --- | --- | --- | --- |
| `{{USER_SETTING_NAME}}` | {{VERIFIED_DEFAULT_OR_UNSET}} | {{WHEN_REQUIRED}} | {{USER_VISIBLE_EFFECT}} |

{{CONFIGURATION_LOCATION_PRECEDENCE_AND_RESTART_REQUIREMENTS}}

{{SAFE_SECRET_CONFIGURATION_USING_PLACEHOLDERS_ONLY}}

<!-- Conditional: user-visible storage locations, retention, export, backup, and recovery only. Internal storage formats, schemas, locks, queues, and caches belong in DEVELOPMENT.md. -->
## Data and storage

{{WHERE_USER_DATA_AND_CONFIGURATION_LIVE}}

{{WHAT_IS_SAVED_HOW_LONG_IT_IS_KEPT_AND_HOW_TO_BACK_IT_UP_OR_EXPORT_IT}}

{{SAFE_RESET_REMOVAL_OR_RECOVERY_STEPS_WITH_WARNINGS}}

<!-- Include when material risks or controls exist. Essential warnings must also remain in the README before the risky step. Explain operational consequences, not enforcement algorithms. -->
## Security and privacy

- {{WHAT_LEAVES_THE_DEVICE_OR_REACHES_AN_EXTERNAL_SERVICE}}
- {{USER_CONTROLS_PERMISSIONS_TRUST_AND_CONFIRMATIONS}}
- {{CREDENTIAL_HANDLING_AND_SENSITIVE_DATA_LIMITATIONS}}

<!-- Conditional: user update, migration, rollback, and recovery steps only. Package publication and contributor-only migrations belong in DEVELOPMENT.md. Do not imply a migration or rollback is automatic unless evidence proves it. -->
## Updates and recovery

{{WHAT_AN_UPDATE_CHANGES_AND_WHAT_IT_PRESERVES}}

{{BACKUP_AND_VERIFIED_MIGRATION_OR_ROLLBACK_STEPS}}

## Limits and troubleshooting

| Symptom or limitation | Check or explanation | Safe next step |
| --- | --- | --- |
| {{VERIFIED_LIKELY_FAILURE_OR_LIMIT}} | {{USER_ACCESSIBLE_DIAGNOSTIC_OR_EXPLANATION}} | {{VERIFIED_FIX_OR_SUPPORT_PATH}} |

{{USER_FACING_HEALTH_CHECK_IF_AVAILABLE_NOT_CONTRIBUTOR_TEST_COMMANDS}}

<!-- Conditional: retain only verified destinations. -->
## Further reading

- [First-use guide](README.md)
- [Contributor and implementation guide](DEVELOPMENT.md)
- {{OTHER_VERIFIED_USER_REFERENCE_OR_SUPPORT_LINK}}
````

## Layer boundaries

Include complete user commands and options, user-editable settings and environment variables, supported runtimes and platforms, operational limitations, user storage locations, privacy controls, safe updates, rollback, recovery, and troubleshooting when evidence supports them.

Keep API/HTTP/RPC endpoint catalogs, request/response/event payloads, schemas, tool contracts, architecture, internal algorithms and state machines, hash construction, locking, queues, source-file maps, development setup, local linking, tests, fixtures, benchmarks, and package-publication internals in `DEVELOPMENT.md`. A user-facing health check is allowed here; a contributor test suite is not.

## Adaptation and verification

- Use repository-local documentation rules first. The template is a menu, not a mandatory section checklist.
- Keep the README's practical first-use path and essential warnings. Link to this reference for depth rather than duplicating it.
- Reuse an existing canonical user reference where appropriate. Do not replace or edit it without authorization.
- Trace commands, settings, defaults, limits, platforms, storage behavior, and security claims to repository evidence.
- Include only useful sections, resolve all placeholders, check balanced fences and links, and scan again for contributor-only material before delivery.
