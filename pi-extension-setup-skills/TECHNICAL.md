# Technical reference: Skills for Pi

Advanced user setup, configuration, compatibility, and troubleshooting information.

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Command

`/skills` opens the scope chooser in Pi's interactive TUI:

1. **Session only**
2. **Global default**
3. **Model default**

Session choices take precedence over an exact case-sensitive provider/model profile. A model profile takes precedence over the global default, which takes precedence over Pi's runtime skill set. **Use inherited defaults** removes the selected override. An empty saved selection intentionally enables no skills.

The selector discovers skills from Pi's standard user and project locations and configured Pi packages. It separates skill names, discovery values, and enabled status into three columns. The selected skill's description appears below the list.

Ordinary search is case-insensitive and fuzzy. Name matches appear before matches requiring discovery/source text, followed by matches requiring descriptions. For example, `research` in a skill name ranks ahead of `research` found only in its source or description. With multiple terms separated by spaces or `/`, all terms must match; terms may span fields. Results that need description text remain last even if another term matches the name. Within each group, closer fuzzy matches appear first. Clearing the search restores the original order.

Four whole-query keywords switch from filtering to sorting. Every row stays visible:

| Search | Rows placed first |
| --- | --- |
| `enabled` | Currently enabled skills |
| `disabled` | Currently disabled skills |
| `auto` | Skills whose Discovery value is exactly `auto` |
| `Pi built-in` | Skills whose Discovery value is exactly `Pi built-in`, if any |

These keywords and Discovery comparisons ignore case, leading/trailing whitespace, and repeated whitespace. Names and descriptions do not affect this ordering. Both the preferred group and the remaining rows keep their original order. If nothing has the requested status or Discovery value, the original list stays visible. Partial keywords and keywords with extra terms use ordinary fuzzy search.

Status sorting updates immediately when you toggle a skill. With `enabled` or `disabled` in search, selection stays on a skill matching that status if one remains; otherwise it follows the toggled skill. Toggling a skill into the searched status also keeps it selected. Searching or sorting does not change statuses or save anything. **Ctrl+A and Ctrl+X affect every skill in sort-only mode.** The footer identifies the sort column and reminds you that bulk actions affect all rows. With ordinary fuzzy search, those shortcuts still affect only matching skills.

The selector keeps saved names that are temporarily unavailable so reinstalling a package does not silently erase a profile.

## Runtime behavior

The extension applies scoped skill choices in TUI mode. It updates the skill list in the system prompt, blocks explicit invocation of disabled skills, and can expand a selected installed skill even when Pi's base settings did not register its native `/skill:name` command.

When Pi starts with `--no-skills` or `-ns`, `/skills` lists only the skills Pi loaded for that session, including explicit `--skill` paths. It does not scan the normal skill locations, so disabling discovery still has its intended effect.

Model changes and session-tree navigation recompute inherited choices immediately. No reload is required after saving. The next prompt applies the selection to both the model's skill list and the current skill list shown in a new HTML export.

A compatible T3 chat launcher applies these same defaults to its Pi session, reading changes before each new prompt and explicit skill invocation. Skill selections stay independent of tool selections. Keeping T3's native tools available does not enable extra skills, create separate T3 skill profiles or automatically hide delegation skills. Session choices come only from the active T3 Pi session branch. Empty selections advertise and allow no skills; inherited runtime choices allow newly loaded skills. Normal discovery restrictions still apply. Installed-skill discovery refreshes at model and session-tree changes, rather than scanning all skill locations on each prompt. Concurrent T3 input and prompt preparation use queued profile reads. A context change is retried once; if it cannot be resolved consistently, that prompt advertises no skills and an explicit skill command asks you to retry instead of silently discarding the input. Other RPC clients, WebUI, print and JSON modes keep their existing behavior. TUI timing stays unchanged.

If an older export lists disabled skills, it may reflect an outdated stored skill list rather than the filtered prompt sent to the model. After updating this extension, run `/reload`, send a message, and export again. Existing export files and earlier transcript entries remain historical snapshots.

## Storage and WebUI compatibility

Global and model selections use the shared resource defaults in `~/.pi/webui/settings.json`. Session selections use `webui-skills-config` entries on the active session branch. WebUI reads and writes the same data, but it does not register the TUI `/skills` command.

The extension preserves unrelated settings and uses the same settings lock protocol as WebUI when writing resource defaults.
