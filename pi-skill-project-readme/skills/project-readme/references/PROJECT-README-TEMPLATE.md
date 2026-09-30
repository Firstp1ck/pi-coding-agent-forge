# Project README template

Use this adaptive template only after inspecting repository-local rules and evidence. Classify the primary audience as **user-oriented** or **developer/library-oriented**, then keep only sections that help that audience. Replace verified placeholders, remove instructional comments, and omit unused conditional sections rather than publishing empty scaffolding.

## Canonical template

````markdown
# {{PROJECT_NAME}}

{{ONE_SENTENCE_OUTCOME: say what the project does, who it helps, and the result it provides.}}

<!-- Conditional trust strip. Include only badges whose target and current status are verified, such as CI, release, package, platform, or license status. -->

<!-- USER-ORIENTED VISUAL PRODUCTS: use the exact heading "Main Window". Search verified repository assets first. If no suitable image exists, ask the user for a path/capture or explicit permission to continue without it. Omit for non-visual projects or explicit opt-out; never invent, generate, capture, or silently substitute an image. -->
## Main Window

![Main window of {{PROJECT_NAME}}]({{MAIN_WINDOW_IMAGE_PATH}})

{{OPTIONAL_ONE_SENTENCE_CAPTION}}

## What you can do

- {{VERIFIED_CAPABILITY_1}}
- {{VERIFIED_CAPABILITY_2}}
- {{VERIFIED_CAPABILITY_3}}

<!-- USER-ORIENTED VISUAL PRODUCTS: identify two to four common user-visible features or workflows that can be shown clearly. If evidence does not establish them, ask the user to name them. Reuse verified images; request paths/captures for missing images. Use descriptive alt text and short outcome-focused captions. Omit empty previews when the user declines. -->
## Common feature previews

### {{COMMON_FEATURE_1}}

![{{DESCRIPTIVE_ALT_TEXT_1}}]({{FEATURE_IMAGE_PATH_1}})

{{SHORT_USER_OUTCOME_CAPTION_1}}

### {{COMMON_FEATURE_2}}

![{{DESCRIPTIVE_ALT_TEXT_2}}]({{FEATURE_IMAGE_PATH_2}})

{{SHORT_USER_OUTCOME_CAPTION_2}}

<!-- Conditional: put Status near the top for an experimental, incomplete, archived, deprecated, or migrating project. State only verified limitations and migration paths. -->
## Status

{{CURRENT_STATUS_AND_USER_IMPACT}}

## Quick start

### Requirements

- {{VERIFIED_RUNTIME_OR_PLATFORM_REQUIREMENT}}
- {{VERIFIED_REQUIRED_TOOL_OR_SERVICE}}

### Install

```bash
{{PRIMARY_INSTALL_COMMAND}}
```

### Run

```bash
{{PRIMARY_RUN_COMMAND}}
```

{{FIRST_SUCCESS: tell the reader what to open, expect, or do to confirm the project works.}}

<!-- DEVELOPER/LIBRARY PROFILE: replace or supplement Run with a minimal working integration example when that is the normal first success. Keep the example on the public integration surface. -->
### Minimal example

```{{LANGUAGE}}
{{MINIMAL_WORKING_EXAMPLE}}
```

{{EXPECTED_RESULT}}

<!-- Conditional: include when the first successful workflow needs more than Quick start. For CLI/TUI projects, a concise command or keyboard reference may fit here. -->
## How to use

1. {{USER_STEP_1}}
2. {{USER_STEP_2}}
3. {{USER_STEP_3}}

<!-- Conditional: user-editable configuration and user-relevant data behavior only. Put this before affected steps when credentials, privilege elevation, destructive actions, privacy, storage, or recovery are involved. USER-ORIENTED PROFILE: do not include internal endpoints, calls, payloads, schemas, or implementation configuration. -->
## Configuration and data

| Setting | Required | Purpose |
| --- | --- | --- |
| `{{SETTING}}` | {{YES_OR_NO}} | {{USER_VISIBLE_PURPOSE}} |

{{WHERE_USER_DATA_IS_STORED_AND_HOW_TO_BACK_UP_RESET_OR_REMOVE_IT}}

<!-- Conditional: preserve essential warnings here even when fuller security documentation exists. Place warnings before readers encounter the risk. -->
## Safety and privacy

- {{IMPORTANT_SAFETY_OR_PRIVACY_BEHAVIOR}}
- {{SAFE_DEFAULT_CONFIRMATION_OR_RECOVERY_BOUNDARY}}
- {{VERIFIED_SECURITY_REPORTING_ROUTE}}

<!-- Conditional: use when platform, runtime, architecture, language, version, or interoperability boundaries affect adoption. -->
## Compatibility

| Area | Supported |
| --- | --- |
| Platforms or runtimes | {{SUPPORTED_PLATFORMS_OR_RUNTIMES}} |
| Languages | {{SUPPORTED_LANGUAGES_IF_RELEVANT}} |
| Important limits | {{VERIFIED_LIMITS}} |

<!-- DEVELOPER/LIBRARY PROFILE ONLY: include concise technology orientation only when it helps integration or contribution. Keep internal architecture and exhaustive implementation detail elsewhere. -->
## Technology

| Layer | Technology |
| --- | --- |
| {{RELEVANT_LAYER}} | {{VERIFIED_TECHNOLOGY}} |

<!-- DEVELOPER/LIBRARY PROFILE ONLY: include only paths normal integrators or contributors need for orientation. Link to deeper contributor documentation rather than reproducing a source map. -->
## Project structure

```text
{{RELEVANT_PATH}}/    {{PURPOSE}}
{{RELEVANT_PATH}}/    {{PURPOSE}}
```

<!-- DEVELOPER/LIBRARY PROFILE ONLY: concise verification may appear here. USER-ORIENTED PROFILE: never include contributor setup, test commands, fixtures, benchmarks, source-build instructions, or source details; link to an existing in-scope contributor document instead. -->
## Development and verification

```bash
{{PRIMARY_VERIFICATION_COMMAND}}
```

See [CONTRIBUTING.md](CONTRIBUTING.md) or [DEVELOPMENT.md](DEVELOPMENT.md) for contributor setup and the complete verification matrix.

<!-- DEVELOPER/LIBRARY PROFILE ONLY: include only when normal readers build or release the project. USER-ORIENTED PROFILE: releases may be linked for installation, but source builds, packaging, publication, and release-maintenance instructions belong elsewhere. -->
## Build and release

```bash
{{PRIMARY_BUILD_COMMAND}}
```

{{VERIFIED_ARTIFACT_LOCATION_OR_RELEASE_DOCUMENTATION_LINK}}

<!-- Conditional: include concise, evidence-backed fixes for likely first-run or operational failures. Link to longer troubleshooting documentation when needed. -->
## Troubleshooting

- **{{SYMPTOM_1}}:** {{VERIFIED_CHECK_OR_FIX_1}}
- **{{SYMPTOM_2}}:** {{VERIFIED_CHECK_OR_FIX_2}}

<!-- Conditional: keep short and current. Prefer an issue tracker or roadmap document for a long backlog. -->
## Roadmap

See [the project roadmap]({{VERIFIED_ROADMAP_LINK}}).

<!-- Conditional: link to existing companion documents or separately approved companions after they are created and verified. Follow the consent step in ../SKILL.md before creating TECHNICAL.md or DEVELOPMENT.md. Approval for one file does not approve the other. Omit each missing or declined destination; never leave a broken link. -->
## Further reading

- [Advanced usage, configuration, and troubleshooting](TECHNICAL.md)
- [Contributor and implementation guide](DEVELOPMENT.md)

## Contributing and support

<!-- Keep only links that exist and serve this audience. For a user-oriented README, support may be the heading if contribution is not relevant. -->
- Report bugs or request features: {{VERIFIED_ISSUE_OR_SUPPORT_LINK}}
- Contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)

## License

{{VERIFIED_LICENSE_SUMMARY}} See [LICENSE](LICENSE).

<!-- Conditional: credit upstream projects, data providers, sponsors, or assets when attribution is useful or required. -->
## Acknowledgments

- {{VERIFIED_CREDIT_OR_ATTRIBUTION}}
````

## Profile rules

### User-oriented

Use for applications, desktop or web products, CLI/TUI tools, setup repositories, and installable packages whose primary reader wants to use the result.

Recommended flow:

1. outcome and verified status, when important;
2. **Main Window** and common-feature previews for visual products;
3. capabilities;
4. quick start and the first normal workflow;
5. user-editable configuration and user-relevant data behavior;
6. safety, privacy, compatibility, and troubleshooting; and
7. support and license.

Include only what helps someone choose, install, configure, use, update, recover, or safely remove the product. Do **not** include development or implementation information: API calls or endpoints, request/response examples, schemas, architecture, technology stack, repository/source layout, internal algorithms, test commands or fixtures, benchmarks, contributor setup, source-build instructions, packaging/publication internals, or release-maintenance procedures. Link to appropriate technical, API, or contributor documentation without summarizing prohibited detail inline.

For a meaningful visual interface, search repository assets and verified user-visible behavior first. If the Main Window image is absent, ask for a path/capture or explicit opt-out. Identify two to four common visualizable features; if evidence does not establish them, ask the user to name them. Request missing feature-image paths or captures. Never invent, generate, capture, or silently substitute features or visuals.

### Developer/library-oriented

Use for libraries, SDKs, APIs, frameworks, reusable modules, and repositories whose normal reader integrates or extends code.

Recommended flow:

1. outcome and verified status, when important;
2. supported runtimes and installation;
3. a minimal working public integration example;
4. links to complete public API or integration documentation;
5. compatibility and verification;
6. concise technical or project orientation only when useful; and
7. support, contribution, and license.

Keep internal algorithms, exhaustive source maps, fixtures, benchmark methods, publication internals, and detailed contributor setup in dedicated documentation.

## Project-type refinements

- **CLI/TUI:** prioritize install, run, concise commands or keyboard controls, configuration, safety, and troubleshooting. Include images only when the interface is meaningfully visual and the gate is satisfied.
- **System or configuration repository:** prioritize prerequisites, safe installation, backup, rollback or removal, customization, and troubleshooting. Put destructive or privilege-related warnings before commands.
- **Early rewrite or prototype:** put status and limitations near the top, avoid claims not yet implemented, and direct readers to verified next steps.
- **Small internal tool:** omit ceremony, but retain requirements, run instructions, ownership or support, and material safety notes.

## Ordering and adaptation

Lead with the outcome and the fastest verified path to success. Put configuration and warnings before their consequences. Place deeper orientation after normal use. Finish with support and legal information.

Repository-local policy and existing security, contribution, license, and technical documents take precedence. In update mode, preserve useful verified material. Ask the user separately before creating a missing `TECHNICAL.md` or `DEVELOPMENT.md`; creation requires an explicit decision for each exact path and substantive evidence for that file. Use the matching companion template only after approval. Relocate detail only when policy calls for it and a destination exists and is within the authorized write scope. Write and verify an approved new destination before removing original content. A declined or unanswered creation keeps the file absent, the content reachable, and the blocked move visible in the handoff. Record why conditional sections were included or omitted, and never infer absent project facts from this template.
