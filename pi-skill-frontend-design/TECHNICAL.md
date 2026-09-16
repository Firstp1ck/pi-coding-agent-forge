# Technical reference: Frontend design

Advanced user information for the `frontend-design` skill.

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Activation

Pi can load the skill when a request involves building, redesigning, or fixing a web interface. Its description covers visual direction, expected interaction behavior, accessible controls, failure recovery, and verification. Automatic selection depends on the model.

To load it explicitly, enable skill commands in Pi and use:

```text
/skill:frontend-design <your brief>
```

## Inputs

The skill works best with:

- a named product or subject;
- the intended audience and the page's single job;
- real copy, images, data, and domain references;
- existing code and design constraints;
- brand, accessibility, browser, and responsive requirements; and
- screenshots or a running preview when visual inspection tools are available.

For an open-ended concept, the skill can choose the subject, audience, and page goal and state the choice. For an existing product, it uses your interface and requirements as evidence rather than inventing a new purpose. State whether the task is a working implementation, a visual-only change, or a mockup.

## Workflow

The skill first examines the existing product and identifies the user's task. It accounts for expected supporting behavior before visual polish, with a short acceptance check for the main action, its result, and a failure or exit path.

For a new visual direction or substantial redesign, it then plans four parts:

1. Four to six named colors with hex values.
2. Typefaces assigned to display, body, and optional utility roles.
3. A layout concept described in short prose and ASCII wireframes.
4. One signature element that expresses the brief.

Before coding, it checks whether each choice could appear unchanged in a similar project. Generic choices must be revised and explained. The implementation follows the revised plan, then receives another visual critique.

For a focused behavior fix, it reuses the established visual design. It does not require a new palette, typography, or layout for every small change.

The quality floor includes mobile layouts, visible keyboard focus, reduced-motion support, working controls, truthful status feedback, and recovery from foreseeable failures. These instructions guide implementation but do not replace browser, accessibility, or usability testing.

## Expected behavior and scope

The skill distinguishes three categories:

- Baseline usability, such as readable content, labeled controls, keyboard access, and truthful feedback.
- Feature-dependent expectations, such as keeping entered values after a failed save, returning focus from a modal, and preventing stale search results from replacing newer ones.
- Product decisions, such as autosave, cross-session draft storage, new permissions, refund rules, or external notifications. Unresolved consequential choices require your input.

It applies only the behaviors relevant to your task. A static article does not need invented async states. A visual-only assignment does not authorize a new backend. Existing business rules and technical constraints remain authoritative.

Realistic examples cover notification settings, storefront search, cinema checkout, team administration, asset uploads, and task boards. The skill uses them to derive acceptance checks, not to add all those features to your project.

## Verification and unavailable tools

When the environment permits, the agent exercises primary tasks in a rendered interface, checks keyboard use and narrow layouts, and tests relevant failure paths. It reports unverified behavior if browser tools or backend access are unavailable. Screenshots and successful builds do not establish persistence, accessible interaction, or error recovery.

If a result is wrong, describe the user action, what happened, and what should have happened. For example: "After a failed save, my daily email selection resets to weekly." Ask Pi to reproduce that path and check its recovery, rather than requesting a general visual cleanup.

## Compatibility

- Pi packages that support the `pi.skills` manifest.
- Other Agent Skills-compatible tools that can load a directory containing `SKILL.md`.
- Frontend work in any framework or in plain HTML and CSS.

The package has no runtime dependencies, helper scripts, settings, or network requirements. Its results still depend on the model and tools available in the host environment.

## Safety and privacy

The package itself executes no code. During a design task, the agent may inspect source files, screenshots, or a local preview when the host provides those tools. Normal tool permissions and confirmation rules still apply.

Review generated code before release. In particular, verify keyboard behavior, contrast, responsive layouts, reduced motion, failure recovery, final copy, and any third-party font or image licenses.

The agent must not claim that simulated saves, payments, uploads, or messages are real. Use test accounts and test data for verification. Real payments, messages, deletions, and other external effects still require authorization. Disabled buttons and hidden actions do not enforce server-side permissions. Preventing repeated clicks does not guarantee that a payment or booking can occur only once.

Preserving input during a failed request does not authorize storing it across sessions. Sensitive drafts, payment details, and retention rules need explicit product decisions.

## Limitations

- The skill does not generate brand requirements when the brief declares them fixed.
- A screenshot can expose visual problems but cannot prove accessibility or behavior in every viewport.
- The examples of common AI design defaults describe current habits and may need revision as those habits change.
- The behavior checklist is not a complete accessibility audit or a guarantee of WCAG conformance.
- Missing backend persistence, authorization, or transaction safeguards cannot be supplied by interface feedback.
- The skill improves design and interaction coverage. It cannot guarantee that every model or implementation will follow the guidance correctly.
