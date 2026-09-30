# Project development guide template

Use this template for an approved `DEVELOPMENT.md` companion to a project README. Before creating the file, follow the companion document consent step in `../SKILL.md`. Approval for `TECHNICAL.md` does not approve this file. This document is for contributors and implementers.

Adapt the sections to verified project evidence and repository-local rules. Replace placeholders, remove instructional comments, and omit irrelevant or empty sections. Do not invent APIs, architecture, test commands, or release procedures. Keep navigation links only when their destinations exist or are approved companion files that will be created and verified in the same task. If `TECHNICAL.md` is absent and declined, omit its link until an approved destination exists.

## Canonical template

````markdown
# Development guide: {{PROJECT_NAME}}

Contributor-only implementation, API, architecture, testing, and maintenance information.

[Back to README](README.md) · [Advanced user technical reference](TECHNICAL.md)

{{CONTRIBUTOR_SCOPE_AND_IMPORTANT_IMPLEMENTATION_LIMITATIONS}}

<!-- Conditional: contributor prerequisites and local setup only. Use the project's actual tools; never install, link, publish, or change global configuration just to verify these instructions. -->
## Local development

{{VERIFIED_DEVELOPMENT_REQUIREMENTS_AND_WORKING_DIRECTORY}}

```bash
{{VERIFIED_LOCAL_SETUP_COMMAND}}
```

{{LOCAL_RUN_OR_BUILD_INSTRUCTIONS_AND_THEIR_SIDE_EFFECTS}}

<!-- Include the smallest map that helps maintenance. Document responsibilities and entry points rather than listing every file. -->
## Source layout

| Path | Responsibility |
| --- | --- |
| `{{IMPLEMENTATION_PATH}}` | {{VERIFIED_RESPONSIBILITY}} |
| `{{TEST_OR_RESOURCE_PATH}}` | {{VERIFIED_RESPONSIBILITY}} |

<!-- Conditional: explain actual component boundaries, control flow, dependencies, and ownership. Skills may document routing, references, and prompt contracts instead of runtime architecture. -->
## Architecture and control flow

{{VERIFIED_ENTRY_POINT_COMPONENTS_AND_REQUEST_OR_TASK_LIFECYCLE}}

{{DEPENDENCY_BOUNDARIES_AND_DESIGN_REASONS}}

<!-- Conditional: API/RPC endpoints, payloads, events, schemas, and tool contracts belong here, not in TECHNICAL.md. Keep only contracts that the project actually exposes or implements. -->
## Interfaces and contracts

{{VERIFIED_API_RPC_OR_TOOL_CONTRACT_WITH_SOURCE_REFERENCES}}

{{INPUT_OUTPUT_EVENT_VALIDATION_ERRORS_AND_COMPATIBILITY_RULES}}

```{{CONTRACT_FORMAT}}
{{VERIFIED_SANITIZED_CONTRACT_EXAMPLE}}
```

<!-- Conditional: implementation storage formats, state transitions, hashes, locks, queues, concurrency, resource limits, timeouts, retries, and cleanup. Explain guarantees and gaps separately. -->
## State and failure handling

{{INTERNAL_STATE_OR_STORAGE_FORMAT_AND_VERSIONING}}

{{CONCURRENCY_RESOURCE_LIFETIME_BOUNDS_AND_FAILURE_BEHAVIOR}}

{{PARTIAL_FAILURE_RECOVERY_AND_UNSUPPORTED_CASES}}

<!-- Conditional: enforcement mechanisms and trust boundaries, with links to user-facing consequences. Never include real secrets, credentials, or private data in examples. -->
## Security implementation

{{TRUST_BOUNDARIES_VALIDATION_PERMISSIONS_AND_ENFORCEMENT}}

{{KNOWN_SECURITY_LIMITATIONS_AND_RELEVANT_TEST_COVERAGE}}

## Validation

From {{VERIFIED_WORKING_DIRECTORY}}, run the relevant checks:

```bash
{{VERIFIED_TEST_COMMAND}}
{{VERIFIED_STATIC_CHECK_OR_BUILD_COMMAND}}
```

{{WHAT_THE_CHECKS_COVER_AND_WHAT_THEY_DO_NOT_PROVE}}

<!-- Conditional: include only actual fixtures, integration/manual checks, or benchmarks. Separate executed results from unrun checks and avoid unverified performance claims. -->
{{FIXTURE_INTEGRATION_MANUAL_OR_BENCHMARK_PROCEDURE_AND_LIMITATIONS}}

<!-- Conditional: contributor-only migrations and maintenance. Link to user update/rollback guidance rather than duplicating it. -->
## Maintenance and migrations

{{COMPATIBILITY_GENERATED_FILE_AND_MIGRATION_RESPONSIBILITIES}}

{{DOCUMENTATION_AND_CONTRACTS_TO_UPDATE_TOGETHER}}

<!-- Conditional: repository packaging, tarball contents, versioning, and publication procedures only when verified. Documenting these commands does not authorize executing a release. -->
## Packaging and releases

{{VERIFIED_PACKAGE_CONTENTS_AND_RELEASE_CHECKS}}

{{PUBLISH_APPROVAL_REQUIREMENTS_AND_RELEASE_PROCEDURE}}

<!-- Conditional: preserve license and provenance information when code, resources, or upstream material require it. -->
## Provenance and contribution

{{VERIFIED_UPSTREAM_ATTRIBUTION_AND_LICENSE_OBLIGATIONS}}

{{EXISTING_CONTRIBUTION_SECURITY_REPORTING_OR_DESIGN_REFERENCE_LINKS}}
````

## Layer boundaries

Preserve implementation and contributor information here, including architecture and source layout, API/RPC endpoints, payloads, schemas, event and tool contracts, internal state, algorithms, hashes, locks, storage formats, validation, fixtures, benchmarks, local development, linking, and repository package-publication procedures.

Leave first-use instructions and essential safety warnings in `README.md`. Put complete user command and configuration references, user storage locations, operational limitations, privacy controls, and safe user update/rollback steps in `TECHNICAL.md` when that destination exists or is approved for creation. Link rather than maintaining duplicate user guidance.

## Adaptation and verification

- Use repository-local rules first. Preserve the required contributor introduction and navigation when applicable.
- Create this guide only when there is substantive contributor or implementation material to preserve. Do not manufacture a runtime architecture for a guidance-only skill.
- Reuse existing canonical API or contribution guides. Ask before editing them or creating further destinations.
- Trace implementation claims, paths, contracts, commands, bounds, and release procedures to repository evidence.
- Check balanced fences, navigation, local paths, sanitized examples, and exact working directories. Report failed or unrun checks accurately.
- Run only authorized validation. Do not install, publish, deploy, migrate real data, or change settings as a side effect of documenting a command.
