# Rewrite in Rust

Assess and carry out Rust migrations with explicit compatibility requirements, your decisions recorded once, and evidence from the original implementation.

## Helpful when

- You want to know whether a Rust rewrite is worthwhile before committing to it.
- You need to replace a module incrementally while the rest of the application keeps working.
- You are porting a bounded codebase or a whole application and need behavior, ownership, and safety checked separately.

## What to share with Pi

- The repository, source revision, and module or application you want to migrate
- Required interfaces, supported platforms, and behavior that must stay compatible
- Available tests, source-language and Rust toolchains, and time, cost, or resource limits
- Your answers to the decision list Pi presents after the assessment, or permission to use the recommended answers

## Try asking

> Assess whether we should port this C++ parser to Rust. Preserve its public API and file format, identify ownership and FFI risks, and propose a way to compare both implementations. Do not change files yet.

After installation, run `/reload` in an existing Pi session, then describe your migration. To select this skill explicitly:

```text
/skill:rewrite-in-rust Plan an incremental Rust port of this parser; do not implement it yet.
```

For implementation, specify the boundary and authorize the work explicitly, for example: "Port only the parser module, preserve the CLI output, and run the existing fixtures against both versions."

## What you’ll get

- A feasibility assessment, a scale classification, and a migration strategy suited to the actual codebase
- A short list of decisions that are yours, each with a recommended answer, collected once after the assessment and once after the pilot
- Compatibility requirements, ownership decisions, a migration contract, and a scoped implementation when requested
- Idiomatic, safe Rust that redesigns source patterns needing `unsafe` instead of copying them
- Verification evidence that distinguishes compilation, behavior, soundness, and remaining gaps

## Keep in mind

This is guidance for an agent, not an automatic translator or a guarantee of equivalence. A whole application is a large-scale port: expect several sessions, a dependency map and work records written into your repository, and a cost estimate you approve after the pilot before the bulk of the work starts. Implementation requests can lead to file changes and command execution. The skill keeps `unsafe` Rust to unavoidable foreign-library boundaries and benchmarked hot paths. Work from a recoverable source revision and use isolated test data; production writes, publication, and deployment need separate authorization.

## Install

```bash
pi install npm:@firstpick/pi-skill-rust-rewrite
```

The package contains the skill and its reference documents. Building or testing a port requires the target project's toolchains; the package bundles no Rust compiler or migration scripts. If you have the Grill Me extension installed, Pi can offer it to collect your decisions as a questionnaire; otherwise Pi asks in the conversation.

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for invocation, the decision rounds, records written into your project, large-scale requirements, compatibility, safety, and troubleshooting.
