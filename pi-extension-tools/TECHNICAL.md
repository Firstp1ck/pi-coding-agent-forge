# Technical reference: Tools for Pi

Advanced user setup, configuration, compatibility, and troubleshooting information.

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Command

`/tools` opens the scope chooser in Pi's interactive TUI:

1. **Session only**
2. **Global default**
3. **Model default**

Session choices take precedence over an exact case-sensitive provider/model profile. A model profile takes precedence over the global default, which takes precedence over Pi's runtime tool set. **Use inherited defaults** removes the selected override. An empty saved selection intentionally enables no tools.

The selector separates tool names, discovery values, and enabled status into three columns. Discovery values distinguish Pi built-ins, SDK custom tools, and extension-provided tools. The selected tool's description appears below the list.

Ordinary search is case-insensitive and fuzzy. Name matches appear before matches requiring discovery/source text, followed by matches requiring descriptions. For example, `wiki` in a tool name ranks ahead of `wiki` found only in its source or description. With multiple terms separated by spaces or `/`, all terms must match; terms may span fields. Results that need description text remain last even if another term matches the name. Within each group, closer fuzzy matches appear first. Clearing the search restores the original order.

Four whole-query keywords switch from filtering to sorting. Every row stays visible:

| Search | Rows placed first |
| --- | --- |
| `enabled` | Currently enabled tools |
| `disabled` | Currently disabled tools |
| `auto` | Tools whose Discovery value is exactly `auto` |
| `Pi built-in` | Tools whose Discovery value is exactly `Pi built-in` |

These keywords and Discovery comparisons ignore case, leading/trailing whitespace, and repeated whitespace. Names and descriptions do not affect this ordering. Both the preferred group and the remaining rows keep their original order. If nothing has the requested status or Discovery value, the original list stays visible. Partial keywords and keywords with extra terms use ordinary fuzzy search.

Status sorting updates immediately when you toggle a tool. With `enabled` or `disabled` in search, selection stays on a tool matching that status if one remains; otherwise it follows the toggled tool. Toggling a tool into the searched status also keeps it selected. Searching or sorting does not change statuses or save anything. **Ctrl+A and Ctrl+X affect every tool in sort-only mode.** The footer identifies the sort column and reminds you that bulk actions affect all rows. With ordinary fuzzy search, those shortcuts still affect only matching tools.

The selector keeps saved names that are temporarily unavailable so reinstalling an extension does not silently erase a profile.

## Runtime behavior

The extension applies scoped tool choices in TUI mode. Model changes and session-tree navigation recompute inherited choices immediately. No reload is required after saving.

## Storage and WebUI compatibility

Global and model selections use the shared resource defaults in `~/.pi/webui/settings.json`. Session selections use `webui-tools-config` entries on the active session branch. WebUI reads and writes the same data, but it does not register the TUI `/tools` command.

The extension preserves unrelated settings and uses the same settings lock protocol as WebUI when writing resource defaults.
