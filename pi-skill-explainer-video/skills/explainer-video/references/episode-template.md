# Episode brief and timing template

Copy this file next to the storyboard as `episode-brief.md` and fill it in before writing scenes. It records what the episode promises, what you may show, and how each visible command was made safe. Keep it with the sources so a later revision can be checked against the same brief.

Leave no field blank. Write "none" or "not applicable" when that is the answer, so a reviewer can tell a decision from an omission.

## 1. Brief

| Field | Answer |
| --- | --- |
| Project and audience | Who will watch, and what they already know |
| Outcome | One sentence: what the viewer can do after watching |
| Tasks shown | The two to five tasks, in order |
| Out of scope | Features or settings this episode deliberately skips |
| Delivery | Clip, episode, or YouTube cut; target length; aspect ratio |
| Requested by and date | Who asked for the episode and when |

## 2. Permissions and disclosure

| Field | Answer |
| --- | --- |
| Product names, logos, screenshots | Who allowed their use, and any limits |
| Data on screen | Fixture, generated or real. Real data needs written consent and must contain no private customer, account or personal information |
| Recreated screens | Which scenes are recreations, and what they may differ in from the real app |
| Music and sound | Original, licensed (name the licence) or none |
| Disclosure text | The exact credit line, for example "Illustrative sample: names and data are invented." Put it in an opening or closing `section.credit` |
| Publication | Who approves publishing, and where it will appear. Rendering locally does not grant permission to upload |

## 3. Build and revision

| Field | Answer |
| --- | --- |
| Version shown | Release number or commit the screens match |
| Source of truth | Where the real behavior was checked: running app, documentation, source file |
| Build or install command | The command used to get that version, if any |
| Known differences | Anything the video shows that this version does differently |
| Recheck trigger | What change in the product means the episode needs revising |

## 4. Language

| Field | Answer |
| --- | --- |
| Caption language | One language per episode. Translate captions rather than mixing languages |
| UI language | The language of the app on screen. Match the captions to it, or explain the mismatch in the brief |
| Terms to keep | Product names and words the audience knows; copy them to `allowTerms` |
| Terms to explain | Words a newcomer would trip over, and the plain wording used instead |

## 5. Start state and result

Describe the fixture so anyone can rebuild the first and last frames.

| Field | Answer |
| --- | --- |
| Start state | What is open, selected and filled in when the episode starts |
| Fixture data | The invented records, files or settings, and where they are stored |
| Visible result | What changes on screen by the end, and in which step the viewer sees it |
| Reset | How to return the app or fixture to the start state for a re-take |

## 6. Command safety

List every command, keystroke or button press that the video shows or that you ran to produce it. Each one needs a safety answer before it appears on screen.

| Step | Command or action | Effect | Changes system or data? | Safe for viewers to copy? | Check done |
| --- | --- | --- | --- | --- | --- |
| 2 | `example --dry-run` | Lists what would change | No | Yes | Ran against the fixture; no files changed |

Rules for the table:

- Show the safe form a viewer can repeat: dry runs, a throwaway directory, invented accounts.
- A command that deletes, overwrites, uploads, installs system-wide, needs administrator rights or spends money needs a visible warning in its caption or a section card, or must stay off screen.
- Never show real tokens, passwords, keys, hostnames or e-mail addresses. Replace them in the scene, not by blurring the frame afterwards.
- Run each shown command against the fixture before rendering, and write what you checked in the last column.

## 7. Timing plan

Plan the running time before writing captions. Each row becomes one storyboard step. Times are cumulative seconds from the start; fill the **Starts at** column from the step durations.

| Step | Kind | Duration | Starts at | Caption or card title | Focus or spotlight | Avoid regions |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | opening | 4 | 0 | Project name and the episode's outcome | none | none |
| 2 | shot | 6 | 4 | First task caption | Target control | Dialog, if one opens |
| 3 | chapter | 4 | 10 | Name of the next task | none | none |
| 4 | shot | 6 | 14 | Next task caption, with `focusFade` | Target control | Changed result |
| 5 | closing | 5 | 20 | What the viewer achieved, credits | none | none |

Checks before rendering:

- Shots run 3–12 seconds. Give a caption about one second per three words, plus time to find the target.
- Section cards need a readable hold after `fadeIn` and before `fadeOut`. Start at four seconds and lengthen for a body line.
- Chapter titles in the description and the embedded chapters come from the same **Starts at** column. Recompute it whenever a duration changes.
- Mark the frame where the visible result appears. A reviewer should be able to pause there and see the change.
- With `captionStyle: "two-line"`, check that no caption needs a third line; the layout report flags it.

## 8. Sign-off

| Check | Result |
| --- | --- |
| Brief, permissions and disclosure agreed with | Name and date |
| Every shown command checked | Yes or the open item |
| Start and result frames inspected | Timestamps |
| Captions, cards and description in the planned language | Yes or the exception |
