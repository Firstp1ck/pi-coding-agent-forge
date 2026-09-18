# Grill Me for Pi

Turn an early idea into a questionnaire-guided design interview before implementation starts.

## What you can do

- Work through related design decisions in short questionnaire rounds.
- See a recommendation and practical choices for each question, with an Other field for your own answer.
- Ask Pi to clarify a question, then continue the same questionnaire without losing earlier answers.
- Keep resolved decisions and remaining risks in a Markdown summary.

## Install

```bash
pi install npm:@firstpick/pi-extension-grill-me
```

Restart or reload Pi if the command does not appear in your current session. Grill Me includes the questionnaire support it needs, so you do not need to install a second package.

## How to use it

Start with the plan or idea you want to examine:

```text
/grill-me Add offline synchronization to the desktop app
```

Pi checks the project for facts it can answer, then groups the decisions it still needs from you into questionnaire rounds. Choose the answers that fit, use Other when the listed choices do not, or ask for clarification before answering.

You can also run `/grill-me` without a plan. The first questionnaire lets you choose a concrete plan already present in the conversation or project, when one exists, or describe one through Other. Grill Me does not invent a missing plan.

Ask Pi to stop or save whenever you want a partial result. The saved document keeps answered decisions separate from unresolved questions.

## Before you start

- Use Grill Me in Pi's terminal interface or a Web UI connected through RPC. Non-interactive modes cannot display the questionnaires.
- The interview is model-guided. The extension checks that questionnaire support is available and stores the answers, while the active model decides which questions and follow-ups to ask.
- Answers are written under the current project and also become part of the Pi session. Do not enter passwords, tokens, private keys, or other secrets.

## Technical details

See [TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-extension-grill-me/TECHNICAL.md) for complete commands, requirements, storage, compatibility, privacy, and troubleshooting information.
