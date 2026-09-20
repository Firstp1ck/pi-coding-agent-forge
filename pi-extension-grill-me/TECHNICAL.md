# Technical reference: Grill Me for Pi

Advanced user setup, behavior, compatibility, privacy, and troubleshooting information.

[Back to README](README.md) · [Contributor and implementation guide](DEVELOPMENT.md)

## Requirements and installation

Grill Me requires Node.js 22.19 or newer and a compatible Pi installation.

```bash
pi install npm:@firstpick/pi-extension-grill-me
```

Restart or reload Pi after installation. The package includes its questionnaire dependency. A separately installed copy of the questionnaire package can remain enabled; Grill Me uses the available questionnaire tool instead of registering another one.

## Command

```text
/grill-me [plan]
```

With a plan, the command creates project-local interview state and asks Pi to begin the interview. Without a plan, the first user-facing step is a single-choice questionnaire. It can name a concrete plan from the current context or let you describe one through Other. It does not use an ordinary chat question for plan intake.

## Questionnaire rounds

Pi first checks the codebase for facts it can establish without asking you. It groups independent decisions into a questionnaire of up to 20 questions and leaves dependent questions for later rounds.

Pi records the newly answered questions from a round together, with one recording confirmation. The saved results still list each question, recommendation, answer, and decision status separately and in order. If a resolved answer is missing, the whole batch is rejected before any answers are stored. Pi must correct the batch and retry.

Each question should provide a recommendation, usable choices, and an Other field. A follow-up still uses a questionnaire when only one question remains. Completing one questionnaire ends that round, not the whole interview. Pi evaluates the answers before deciding whether another round is needed.

If you ask Pi to clarify a question, Pi explains it in normal text and resumes the same pending questionnaire. Earlier answers stay in place. Cancelling the questionnaire stops the interview instead of reopening it or switching to chat questions.

This loop is model-guided. The extension enforces availability checks and answer storage, but prompt instructions cannot guarantee that every model will choose ideal questions or follow every interview step.

## Saving and stopping

When the interview finishes, Pi saves the shared understanding, agreed decisions, and open risks. You can ask it to stop or save sooner. A partial result retains answered decisions and identifies what still needs a decision.

The default files are:

```text
.pi/grill-me/state.json   # current structured interview state
GRILL-ME.md               # default Markdown result
```

You can ask Pi to save the result to another project-relative path. Grill Me refuses result paths outside the current project.

Starting `/grill-me` again replaces the current state file for that project. Save the existing result first if you want to retain it separately.

## Configuration and compatibility

Grill Me has no required settings or environment variables.

Questionnaires work in these modes:

| Pi mode | Supported | Notes |
| --- | --- | --- |
| Terminal interface | Yes | Uses Pi's interactive selectors and text input. |
| RPC with a Web UI or interactive client | Yes | The client must answer Pi's questionnaire UI requests. |
| JSON | No | This mode has no interactive questionnaire UI. |
| Print | No | This mode has no interactive questionnaire UI. |

The `questionnaire` tool must be registered and active. Grill Me pauses before creating or replacing state when the UI is unavailable, the tool is missing, or the tool is disabled.

## Privacy and safety

Questionnaire answers are visible to the active model and persist in the Pi session. Grill Me also stores them in the current project's `.pi/grill-me/state.json` and in any Markdown result you save.

Questionnaire fields are not secret inputs. Do not enter passwords, API keys, access tokens, private keys, or other credentials.

Review saved files before sharing or committing them. Remove or ignore them according to your project's data policy.

## Troubleshooting

- **The command is missing.** Restart or reload Pi after installation.
- **Pi reports that questionnaire UI is unavailable.** Run Grill Me in the terminal interface or through an RPC client that supports Pi extension dialogs.
- **Pi cannot find the questionnaire tool.** Reinstall Grill Me, reload Pi, and try again. The published package includes the required questionnaire code.
- **Pi reports that the questionnaire tool is disabled.** Enable the tool, reload Pi, and rerun the command. Grill Me leaves existing interview state untouched while the tool is unavailable.
- **A cancelled interview did not continue.** This is intentional. Run `/grill-me` again when you want to start a new interview, or continue from the saved partial result.

## Removal

Remove the package with:

```bash
pi remove npm:@firstpick/pi-extension-grill-me
```

Removing the package does not remove project files you already created. Delete `.pi/grill-me/state.json` and saved result files separately if you no longer need them.
