---
description: Create five distinct landing pages for a second-brain note-taking app
argument-hint: "[brand, stack, or visual direction]"
---

Design and implement five distinct landing page concepts for a note-taking application that acts as a second brain.

Additional context: `${ARGUMENTS:-No additional context provided}`

Start by inspecting the repository, its local instructions, the existing frontend stack, and its design conventions. Reuse the current framework, routing system, components, and dependencies where they fit.

Build all five concepts as working pages:

- Make them available at `/1`, `/2`, `/3`, `/4`, and `/5` through the project's normal pages or route directory.
- Put a compact, unobtrusive switcher on every concept so I can move among all five routes without editing the URL. Use buttons or links, show which concept is active, and make the control usable by keyboard.
- Give each concept a clear and substantially different visual direction. Do not submit one layout with five palette swaps.
- Write real landing-page copy for a second-brain note app. Include a clear value proposition, useful product details, and focused calls to action.
- Use responsive layouts that work on narrow and wide screens.
- Meet basic accessibility expectations: semantic structure, visible focus states, labeled controls, readable contrast, and reduced-motion support where animation is used.
- Keep interactions functional. Do not add decorative controls that appear clickable but do nothing.
- Avoid generic AI landing-page habits such as excessive gradients, floating blobs, interchangeable feature-card grids, and unsupported marketing claims.

Choose five directions that fit the available brand context. Vary composition, typography, density, color, imagery or illustration treatment, and interaction patterns. Shared routing or switcher code is fine, but do not reuse one hero, section order, or component composition across all five pages.

If a requested route already contains unrelated work, do not overwrite it silently. Explain the conflict and choose the safest compatible approach. Ask before adding a new framework or major dependency when the repository does not already establish one.

When finished:

1. Run the relevant formatter, type checks, tests, and build available in the project.
2. Inspect all five routes at mobile and desktop sizes when browser or screenshot tools are available.
3. Report the files changed, the visual idea behind each route, and the checks that passed or could not be run.
