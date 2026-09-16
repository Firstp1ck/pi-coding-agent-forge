---
name: frontend-design
description: Use when building, redesigning, or fixing a web interface. Combines distinctive visual direction with expected interaction behavior, accessible controls, complete user flows, failure recovery, and verification. Infer ordinary usability requirements without inventing product features.
license: Apache-2.0
compatibility: Portable Agent Skills skill. No scripts, assets, or runtime dependencies.
---

# Frontend design

Act as a product designer and frontend engineer responsible for both visual identity and usable behavior. A screen is not complete because it looks finished or compiles. The user must be able to complete its intended task, understand the result, and recover from foreseeable failure.

Make firm choices about palette, typography, and layout based on the brief. For new visual directions, take one aesthetic risk and explain why it belongs. For existing products, preserve established design and interaction conventions unless the task calls for changing them. Spend novelty on presentation, not on making ordinary controls unfamiliar.

## Ground the design in its subject

Inspect the existing interface, routes, components, data access, and tests before deciding what is missing. Name the subject, its audience, and the page's single job. For an open-ended concept with no subject, choose one and state the choice. For an existing product, use the available evidence rather than inventing a new purpose or business rule.

Use anything you know about the person's preferences, what they are building, or earlier designs as evidence. Look to the subject itself for materials, instruments, artifacts, language, and visual references. Use real content from that world throughout the design.

## Treat expected behavior as part of the requirement

The brief is not an exhaustive interaction specification. Implement ordinary behavior needed to use the requested feature safely and accessibly even when the user does not name it. Do not ask whether a form should retain input after an error or whether a dialog needs keyboard support. Those are implementation responsibilities, not optional enhancements.

Before coding, read [Expected interface behavior](references/expected-behavior.md). Use its categories and the application examples that match the task. Apply requirements only when their trigger exists. A static article needs working links and readable reflow, not invented loading spinners, accounts, or autosave.

Classify missing behavior before acting:

- **Baseline usability.** Implement semantic controls, meaningful labels, visible focus, responsive access, and truthful feedback for the interactions you build.
- **Feature-dependent expectations.** Implement the supporting behavior implied by an existing feature, such as recoverable form errors, search-result freshness, or focus return from a modal. Follow established project conventions.
- **Product decisions.** Ask before making unresolved choices that change business rules, permissions, costs, external effects, or data storage and retention. Autosave, cross-session drafts, offline sync, new authentication, and bulk actions are not automatic requirements.

A behavior is implied when omitting it makes the requested task misleading, inaccessible, lossy, or inconsistent with the control's established meaning. Familiarity alone does not justify adding a new feature. Implement the smallest complete flow. Respect explicit mockup-only or visual-only scope; identify behavior gaps without silently expanding the assignment. Clearly label simulations and unconnected controls. Never present a mock operation as a real save, send, upload, booking, or payment.

### Plan the interaction before the decoration

For each primary user task in scope, write a compact acceptance check covering the starting state, action, observable result, and failure or exit path. Inventory every visible interactive control in the affected flow, including secondary links, menus, close buttons, and row actions. Each must work as labeled or explain why it is unavailable. No dead buttons, placeholder links, or invented success messages in a working implementation.

Consider initial loading, empty data, no matches, populated data, in-progress actions, success, validation errors, service failures, and disabled or permission-limited states. Implement only the states the feature can reach. Distinguish an empty result from a failed load. Preserve user input during recoverable failures. Prevent accidental duplicate actions, and do not let an older response overwrite a newer result.

Make save, cancel, back, retry, and dismissal behavior explicit where they apply. Cancellation of a dialog is not proof that a server operation was canceled. Do not hide uncertain outcomes behind a retry that could repeat a payment, booking, or message. Use real backend capabilities; frontend feedback cannot supply missing persistence, authorization, or transaction guarantees. Report those dependencies instead of faking them.

Keep this pass proportional to the task. A button fix needs a focused check, not a product specification. Resolve consequential uncertainty with the user, but proceed with conventional low-risk behavior supported by the project.

## Design principles

On a landing page, the hero should make the main argument. In a task-oriented application, put the current task and relevant controls first; do not force a marketing hero into a settings page or workspace. Open with the detail that best captures the subject. That might be a headline, image, animation, working demo, or interaction. Choose it for a reason. A large number, small label, row of statistics, and gradient accent is a stock answer. Use that pattern only when the subject calls for it.

Typography gives the page much of its character. Choose display and body faces for this project, not because they are familiar defaults. Define a clear type scale and set weights, widths, and spacing with care. The type treatment should contribute to the identity rather than merely carry the words.

Structure should explain the content. Numbering, eyebrows, dividers, and labels must communicate something real. Numbered markers such as `01 / 02 / 03` make sense for a sequence, process, or timeline where order matters. Do not add them as decoration.

Use motion where it earns its place. Consider a page-load sequence, scroll reveal, hover response, or ambient movement. One composed moment often works better than effects scattered across the page. Some designs need no animation at all. Extra motion can make the result look machine-generated.

Match the implementation to the direction. Maximalist work needs enough detail to feel complete. Minimal work depends on exact spacing, type, and proportions. Execute the chosen direction cleanly.

Treat copy as part of the design. If the brief has no final text, write copy that belongs to this product and audience. Generic copy can flatten an otherwise specific design. The writing guidance below explains how to avoid that.

## Brainstorm, plan, critique, build, then critique again

Current AI-generated design often falls into a few familiar styles:

1. A warm cream background near `#F4F1EA`, a high-contrast serif display face, and a terracotta accent.
2. A near-black background with one acid-green or vermilion accent.
3. A broadsheet layout with hairline rules, square corners, and dense newspaper columns.

Any of these can suit the right brief. The problem is using them by reflex, regardless of the subject. Follow any visual direction stated in the brief, even when it asks for one of these styles. When the brief leaves a choice open, use that freedom to find something more specific. Bring your own strengths, but treat each project as a chance to try something new.

Plan behavior first, then visual direction. For a new design or substantial redesign, define these parts in a short plan. For a focused behavior fix, reuse the existing palette, type, and layout rather than redesigning them.

- **Color.** Give four to six palette colors names and hex values.
- **Type.** Assign typefaces to at least two roles. Use a distinctive display face with restraint, a complementary body face, and a utility face for captions or data when needed.
- **Layout.** Describe the layout in one-sentence sketches. Use ASCII wireframes to compare ideas.
- **Signature.** Choose the one element people should remember. It must express the brief rather than decorate the page.

Review the plan before you build. Ask whether each choice could appear unchanged in any similar project. If it could, revise it. Say what you changed and why. Start coding only after the plan fits the brief and the primary task has observable acceptance checks. Follow the revised plan and derive each color and type choice from it.

Watch for CSS rules that override one another. A broad class such as `.section` can conflict with a component class such as `.cta`, especially when both set padding or margins. Give each rule a clear responsibility.

Do most planning and revision internally. Show ideas to the user when they are developed enough to judge.

## Use restraint and critique your work

Spend your boldness in one place. Let the signature element carry the surprise. Keep the rest quiet and disciplined. Remove decoration that does not support the brief. Refusing every risk can produce work that nobody remembers.

Meet the basic quality bar without calling attention to it. Support mobile layouts, visible keyboard focus, and reduced-motion preferences. Review the design as you build. Take screenshots when the environment allows it because visual mistakes are easier to catch in an image. Before you finish, remove decoration that the page does not need, but keep labels, feedback, and recovery controls needed to complete the task.

Keep brief notes about ideas you have already tried when you have somewhere appropriate to store them. Use those notes to avoid repeating the same design in later work.

## Verify complete tasks before calling the work done

Exercise each primary flow in the rendered interface when tools permit. Check the result of the action, not just the click handler or screenshot. Run the relevant project tests and add focused regression coverage for changed behavior using existing test tools.

- Walk the happy path and a reachable failure or recovery path. Check empty and in-progress states when applicable. Confirm that a failed save retains the user's edits and never reports success.
- Use keyboard-only navigation. Check names, labels, focus order, visible focus, modal dismissal, and focus return. Check screen-reader feedback when tools permit; automated checks alone do not prove accessibility.
- Check a narrow viewport, zoom, long content, and reduced motion. Ensure essential controls remain reachable without hover or dragging alone.
- For asynchronous interactions, exercise a slow response and repeated activation. For search, test out-of-order results. For writes, confirm the chosen duplicate-action protection and handle uncertain outcomes honestly.
- Test back navigation and reload where the feature promises preserved state or persistence. Verify destructive-action safeguards without acting on real user data or external systems without authorization.

Review the control inventory again. Fix broken secondary controls and misleading states before adding polish. Report what was exercised, which assumptions remain, and which checks could not run. If browser tools or a working backend are unavailable, state that limitation. Do not claim interaction verification from a build, static inspection, or screenshots alone.

## Write interface copy that helps

Words should make the interface easier to understand and use. Treat them with the same care as spacing and color. Before writing, decide what the interface needs to say and what the person needs to do next.

Write from the user's side of the screen. Name things by what people recognize and control, not by internal implementation. A person manages notifications, not webhook configuration. Explain what something does instead of trying to sell it. Prefer a precise phrase over a clever one.

Use active voice. A control should name the result of using it. Write "Save changes," not "Submit." Keep action names consistent through the whole flow. A button labeled "Publish" should lead to a message that says "Published." Repeated terms help people learn the interface.

Use errors and empty states to give direction. Explain what went wrong and how to fix it in the interface's voice, not a staff member's voice. Do not make errors apologize or hide the cause behind vague language. An empty state should offer a useful next action.

Keep the language conversational and suited to the brand and audience. Use plain verbs, sentence case, and no filler. Give each element one job. A label names something. An example demonstrates it. Do not ask either one to carry unrelated information.

## Modification notice

Adapted from Anthropic's frontend-design skill under Apache 2.0. This file has been modified. Firstpick's version adds visual and copy guidance, expected interaction behavior, scope boundaries, application examples, and task-based verification.
