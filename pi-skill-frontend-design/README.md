# Frontend design

Build web interfaces with a distinct visual identity and the everyday behavior people expect, even when the brief leaves it unstated.

## Helpful when

- You are building a landing page, product interface, portfolio, or other web UI from a loose brief.
- An existing design works but looks generic, overdecorated, or disconnected from its content.
- Your screens look finished, but users still lose edits, hit dead controls, or cannot recover from errors.
- You need firm choices for typography, palette, layout, motion, and interface copy before writing code.

## What to share with Pi

- The product, audience, and single job of the page.
- Existing UI code, brand rules, content, screenshots, and technical constraints.
- Anything that must stay, plus the parts where Pi may take a real design risk.
- Whether this is a visual mockup or working application, and any fixed save, permission, payment, or data-storage rules. You do not need to list ordinary keyboard behavior or error recovery.

## Try asking

> Redesign our cinema's seat-selection and checkout screens as a working flow. Keep the existing booking service, prices, and brand. Make the screening and selected seats easy to review. Do not change payment or refund policies.

## What you'll get

- For a new visual direction, a compact plan for color, type, layout, and one signature element.
- Visual choices tied to the brief rather than reusable design defaults.
- A self-critique before implementation, with generic choices revised or removed.
- Working interactions with appropriate loading, empty, error, success, and recovery states.
- Mobile and keyboard access, reduced-motion support, and useful interface copy.
- Task-based checks and an honest report of what could and could not be verified.

## Keep in mind

For an open-ended concept, the skill can choose a subject and state its assumptions. For an existing product, it follows your established conventions and implements ordinary usability without inventing business rules. It asks about unresolved choices that change permissions, costs, external effects, or data storage. A mockup remains a mockup; it must not pretend to save, charge, or send anything.

Review generated work before release. Use test data for destructive or paid actions; a frontend control is not a substitute for server-side authorization or payment safeguards.

The package contains instructions only. It does not add executable scripts or dependencies. Screenshot capture, browser testing, and code changes still depend on the tools available in your Pi session.

## Install

```bash
pi install npm:@firstpick/pi-skill-frontend-design
```

Pi can load the skill automatically for matching frontend work. You can also invoke it directly with `/skill:frontend-design` when skill commands are enabled.

## Source and license

Adapted from Anthropic's [`frontend-design` skill](https://github.com/anthropics/skills/tree/main/skills/frontend-design). Licensed under the [Apache License 2.0](LICENSE).

## Technical details

See [TECHNICAL.md](TECHNICAL.md) for activation, workflow, compatibility, safety, and limitations.
