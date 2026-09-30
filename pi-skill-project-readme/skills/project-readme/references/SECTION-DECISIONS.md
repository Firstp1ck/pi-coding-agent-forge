# README section decisions

This catalog explains how the `project-readme` skill decides whether common project README material belongs in the root README. Its starting point is a recorded heading inventory from 14 non-forge README files across 12 project directories, with this repository and two representative skill packages used only for secondary package conventions. Repository evidence and local documentation rules remain authoritative for every project.

## Inspected heading inventory

The source corpus was inspected before package implementation. Project identifiers below are repository-relative labels; private host paths are deliberately omitted. Short stubs remain in the inventory because they show that the template must scale down. Test fixtures, vendored documentation, command templates, copied third-party READMEs, memory files, and narrow operational notes were excluded because they are not project landing pages.

| README | Observed H2 headings |
| --- | --- |
| `Abweichungsprozess/README.md` | What Changed; Requirements; Install; Run From Source; Build Single EXE (PyInstaller); Build NSIS Installer; Output; Troubleshooting |
| `Abweichungsprozess/Documents/README.md` | None; title and one-sentence stub only |
| `Abweichungsprozess-rewrite/README.md` | Development; Tests and checks; Desktop build; Release |
| `Budget-Planer/README.md` | Features; Screenshots; Quick Start; Getting Started; Desktop Application; Currency Support; Supported Languages; Contributing; License; Support; Acknowledgments |
| `Databases/README.md` | None; title and one-line description only |
| `Externe-Analytik-rewrite/README.md` | Status; Repository layout; Prerequisites (all install per-user, no admin); Dev loop; Runtime assets (dev vs bundle); License |
| `Hyprland-Simple-Setup/README.md` | Example Images; Example Terminal and Musik Visualizer; Table of Contents; Introduction; TUI Testing; Environment Setup; Prerequisites; Installation Details; Project Structure; Setup Script Execution; Package Installations; Manuell Installation & Configuration; Change Wallpaper with the Wallpaper Script; Terminal Experience; Customization; Troubleshooting; Additional Resources; Contributing & Support; License |
| `Laboratory-Dashboard-App/README.md` | Features; Technology Stack; Project Structure; Getting Started |
| `Lagerverwaltung-Web/README.md` | Features; Tech Stack; Getting Started; Quick Reference; Project Structure |
| `Pacsea/README.md` | Community; Supported Platforms; Demo; Table of Contents; Quick start; Features; Security-first approach for AUR Packages; Usage; CLI Commands; Configuration; Optional: build from source; Troubleshooting; Roadmap; Credits; License; Wiki; Contributing |
| `UniPack/README.md` | Features; Supported Package Managers; Installation; Keyboard Shortcuts; Usage; Built With; License |
| `UsrGrp-Manager-TUI/README.md` | Safety model; Build and run; Configuration; Verification |
| `laboratory-planner/README.md` | Combined-product status; Vacation planner (existing foundation); Feature overview; Stack; Prerequisites; Run the app locally; Demo accounts; User guide; Data and configuration; Build and release; Project layout; Troubleshooting |
| `laboratory-planner/backend/README.md` | Development |
| `pi-coding-agent-forge/README.md` *(secondary)* | Start here; Find what you need; Technical and contributor information |
| `pi-skill-feature-development-workflow/README.md` *(secondary)* | Helpful when; What to share with Pi; Try asking; What you’ll get; Keep in mind; Install; Technical details |
| `pi-skill-html-report/README.md` *(secondary)* | Helpful when; What to share with Pi; Try asking; What you’ll get; Keep in mind; Install; Technical details |

### Normalized section families

Exact headings vary while serving the same reader need. The inventory supports these normalized families:

| Family | Representative headings | Observed use |
| --- | --- | --- |
| Purpose and outcome | Intro text; Introduction; status summaries | Present in every usable project README; essential. |
| Capabilities | Features; Feature overview | Common for user-facing products; absent mainly from stubs and narrow developer notes. |
| Fast setup | Quick Start; Getting Started; Install; Build and run; Dev loop | Dominant actionable pattern across mature projects. |
| Requirements | Requirements; Prerequisites; Environment Setup; Supported Platforms | Used when runtime or platform constraints affect adoption. |
| Usage | Usage; User guide; CLI Commands; Keyboard Shortcuts | Common for interactive products, with project-specific depth. |
| Configuration and data | Configuration; Data and configuration; Runtime assets; Customization | Important when users control state, paths, environment, or behavior. |
| Safety and security | Safety model; Security-first approach; privilege notes | Infrequent as a heading but mandatory when consequences are material. |
| Technical orientation | Stack; Tech Stack; Technology Stack; Built With; project layout | Common in contributor or integration-oriented repositories, but not a universal user need. |
| Verification and release | Tests and checks; Verification; Desktop build; Release | Conditional on reader role and distribution model. |
| Troubleshooting and support | Troubleshooting; Community; Contributing; Support | Recurs in setup-heavy and public projects. |
| Legal and credit | License; Credits; Acknowledgments | License is expected when verified; other credit is conditional. |
| Navigation and media | Table of Contents; Screenshots; Demo; Wiki | Useful only when product type or document length justifies it. |
| Status and history | Status; What Changed; Roadmap | Useful for current lifecycle context; long history becomes stale. |

## Decision meanings

- **Include:** part of the normal path for the selected audience when verified content exists.
- **Conditional:** include only when project evidence, project type, reader needs, or risk makes it useful.
- **Relocate:** link or move the detail to a more appropriate document, provided that destination exists and is within the authorized write scope. A missing `TECHNICAL.md` or `DEVELOPMENT.md` must receive separate explicit creation approval and be written and verified before original content is removed.
- **Exclude:** omit unsupported, irrelevant, misleading, empty, secret, or prohibited content.

A decision applies to content, not merely a heading. Existing projects may use different clear headings while preserving the same reader outcome, except that qualifying visual user products use the exact **Main Window** heading.

## Section catalog

| Section or content | Default decision | Audience/profile | Reason and adaptation |
| --- | --- | --- | --- |
| Project name and one-sentence outcome | Include | Both | Gives readers immediate identity, audience, and purpose. Use repository evidence; do not invent positioning. |
| Badges or trust strip | Conditional | Both | Useful only when targets and status are verified and meaningful. Exclude decorative, stale, or unverifiable badges. |
| Status and limitations | Conditional | Both | Move near the top for prototypes, rewrites, archived or deprecated projects, and migrations whose state affects adoption. Exclude when there is no material status to report. |
| Main Window | Conditional with required gate | User-oriented visual products | Search verified assets first. If missing, ask for a path/capture or explicit opt-out. Exclude for non-visual projects or explicit opt-out; never fabricate or substitute. |
| What you can do | Include | User-oriented; often useful for developer/library | Helps readers judge fit through verified capabilities. Keep concise and audience-facing rather than listing implementation components. |
| Common feature previews | Conditional with required gate | User-oriented visual products | Use two to four representative, verified visualizable features. Ask the user to name unclear features and request missing images. Omit empty placeholders after opt-out. |
| Quick start | Include | Both | Provides the shortest verified path to first success. Adapt the steps to install-and-run or install-and-integrate. |
| Requirements | Include when prerequisites exist | Both | Prevents predictable setup failure. State only verified platforms, runtimes, tools, services, or access needs. |
| Install | Include when installation is part of normal use | Both | Supports first use. For projects that need no installation, replace with the verified preparation step rather than retaining an empty heading. |
| Run | Include for runnable projects | User-oriented and runnable developer tools | Defines first execution and expected success. Libraries normally replace it with a minimal integration example. |
| Minimal code example | Include for normal library integration; otherwise exclude | Developer/library only | Demonstrates the public integration surface. User-oriented product READMEs exclude code-level integration material. |
| How to use | Conditional | Both | Add when first success requires a workflow beyond quick start. For CLI/TUI projects, a short command or keyboard reference may fit here. |
| Configuration and data | Conditional | Both, with profile-specific depth | Include user-editable settings, storage, backup, reset, credentials, and operational consequences. In user-oriented READMEs, relocate endpoints, payloads, schemas, and implementation configuration. |
| Safety and privacy | Conditional but mandatory when material risk exists | Both | Essential warnings must remain visible before risky steps even when fuller security documentation exists. Never hide destructive, privilege, credential, or privacy consequences in contributor docs. |
| Compatibility | Conditional | Both | Include when platform, runtime, language, version, architecture, or interoperability boundaries affect adoption. Exclude unsupported guesses. |
| Public API or integration documentation link | Include when applicable | Developer/library | Directs integrators to the complete public contract. Keep endpoint catalogs, payload schemas, and exhaustive API reference out of the project README. |
| Technology stack | Conditional | Developer/library only | A concise orientation may help integration or contribution. Exclude from user-oriented READMEs and relocate architecture depth. |
| Project or source structure | Conditional | Developer/library only | Include only a short map normal integrators or contributors need. Exclude from user-oriented READMEs and relocate exhaustive source maps. |
| Development and verification | Conditional | Developer/library only | Concise verification may support integrators or contributors. In user-oriented READMEs, relocate contributor setup, tests, fixtures, benchmarks, and source detail to contributor documentation. |
| Build and release | Conditional | Developer/library only | Include only when building or releasing is a normal concern for the primary reader. User-oriented READMEs may link downloadable releases for installation but relocate source builds, packaging, publication, and release maintenance. |
| Update, migration, rollback, recovery, or removal | Conditional; include when operationally relevant | User-oriented primarily | These are user tasks when they affect safe continued use. Put them near installation/configuration or in advanced user docs; do not confuse user-visible release steps with maintainer publication internals. |
| Troubleshooting | Conditional | Both | Include concise, evidence-backed fixes for likely first-run or operational failures. Relocate long catalogs and implementation diagnosis to appropriate docs. |
| Roadmap | Conditional | Both | Include only when current, useful, and verified; prefer a link over a duplicated backlog. Exclude stale promises. |
| Support and issue reporting | Include when a verified channel exists | Both | Gives readers a next step. Adapt the heading and links to the project's actual support model. |
| Contributing | Conditional | Both | Link a contribution guide when it exists. Keep user-oriented READMEs free of contributor setup and implementation detail. |
| Security reporting | Conditional but mandatory when a verified route exists and risk warrants it | Both | Link the safe reporting route without exposing secrets or replacing fuller security guidance. |
| License | Include when verified | Both | State the verified license and link its file. Never infer a license from package metadata alone when repository evidence conflicts or is absent. |
| Acknowledgments and attribution | Conditional | Both | Include when credit is useful or legally required. Exclude generic ceremony and unverified claims. |
| Table of contents | Conditional | Both | Useful for a long README; unnecessary in a short, scannable document. Do not add by habit. |
| FAQ | Conditional | Both | Include only for repeated user questions supported by evidence. Merge isolated first-run issues into troubleshooting when clearer. |
| Changelog or release history | Relocate | Both | Link a changelog or releases page. Avoid duplicating volatile release history in the README. |
| TECHNICAL.md companion | Conditional, with creation consent | Advanced users | Use for complete user commands, settings, runtime requirements, compatibility, storage, privacy controls, updates, recovery, and troubleshooting. Ask before creating a missing file; omit empty or duplicate documents and broken links. |
| DEVELOPMENT.md companion | Conditional, with creation consent | Contributors and implementers | Use for architecture, source layout, contracts, schemas, state, development, tests, and maintenance. Ask independently before creating a missing file; the technical-file answer does not approve this file. |
| Full API endpoint/call catalog, payloads, and schemas | Relocate or exclude | Both; prohibited inline for user-oriented | Belongs in `DEVELOPMENT.md` or an existing canonical API reference, not the advanced user `TECHNICAL.md`. A developer/library README may show only a minimal public integration example and link the complete contract. |
| Architecture and internal algorithms | Relocate | Both | Belongs in `DEVELOPMENT.md` or existing canonical contributor documentation, not `TECHNICAL.md`; omit from user-oriented READMEs and avoid architecture dumps in developer/library READMEs. |
| Exhaustive source-file maps | Relocate | Both | Detailed source layout is contributor material. A concise orientation is conditional only for developer/library projects. |
| Test fixtures, benchmark methods, and contributor test matrices | Relocate | Both | These are contributor details. Developer/library READMEs may retain one concise verification command when useful; user-oriented READMEs exclude them. |
| Contributor setup and local linking | Relocate | Both | Belongs in contribution or development documentation, never the user-oriented README. |
| Packaging, publication, and release-maintenance internals | Relocate | Both | Maintainer procedures belong in contributor documentation. User-visible release installation or rollback remains allowed. |
| Secrets, real credentials, private paths, or copied demo passwords | Exclude | Both | Creates security and privacy risk. Use safe placeholders only when configuration is documented. |
| Unverified commands, features, compatibility, links, license details, or visuals | Exclude pending evidence | Both | Report the gap or ask for evidence instead of converting a template placeholder into a claim. |
| Empty optional headings and placeholder scaffolding | Exclude | Both | A finished README should contain useful project-specific content, not the template's instructional structure. |

## Profile summaries

### User-oriented profile

The root README is for choosing, installing, configuring, using, updating, recovering, and safely removing the product. Include outcome, capabilities, first success, material configuration, warnings, troubleshooting, support, and license. Apply the visual gate to meaningful visual interfaces. Relocate all development and implementation information, including calls or endpoints, request/response examples, schemas, architecture, stack, source layout, algorithms, tests, benchmarks, contributor setup, source builds, packaging/publication, and release maintenance.

### Developer/library-oriented profile

The root README helps a reader integrate or extend reusable code. Include install, supported runtimes, a minimal working example on the public integration surface, compatibility, verification when useful, and links to complete API or contributor documentation. Concise technology or structure orientation is conditional; internal algorithms and exhaustive maintenance detail remain relocated.

## Companion document decisions

Use `PROJECT-TECHNICAL-TEMPLATE.md` for the advanced user reference and `PROJECT-DEVELOPMENT-TEMPLATE.md` for the contributor guide only after the consent step in `../SKILL.md`. These templates draw on this repository's package documentation, but repository-local rules and verified target-project evidence determine the actual content.

For each missing companion, explain the proposed content and ask for its exact-path creation decision. Each answer is independent; allow both, either, or neither. A prior explicit same-file approval may be recorded without repeating the question. Do not infer approval from README scope, local policy, silence, or a link. Declined or unanswered means no creation. An existing document may be linked without edit authority, but edits still require scope. Review-only work recommends rather than creates.

Do not create an empty or duplicate companion. If creation is declined or unsupported, keep verified content reachable and report the blocked move. Remove missing companion links. If preserving the content would conflict with local policy, ask for a decision rather than silently deleting it.

`TECHNICAL.md` contains advanced user operations, not endpoint catalogs, payloads, schemas, tool contracts, architecture, algorithms, source maps, development setup, tests, fixtures, benchmarks, or publication internals. Those details belong in `DEVELOPMENT.md` or an existing canonical implementation reference. Essential first-use and safety information stays in the README.

## Evidence and adaptation record

For each README task, the workflow should be able to state:

1. the selected audience profile and project-type refinement;
2. the repository-local rules consulted;
3. the evidence used for project claims and visuals;
4. which conditional sections were included or omitted and why;
5. what verified content was preserved or relocated in update mode;
6. the independent creation decisions and paths for companion documents, including unchanged existing files and blocked moves; and
7. unresolved evidence gaps, visual requests, or explicit opt-outs.

This catalog does not claim that any section is universal or statistically common. It is a policy-driven starting point approved for this package and must yield to verified project needs.
