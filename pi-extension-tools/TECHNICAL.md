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

A saved selection limits which tools the model can use, including tools registered later. Excluded tools are removed from model requests and their calls are blocked even if another extension reactivates them. Selected tools can still be held inactive by the extension that provides them. When every scope inherits Pi's runtime default, dynamic tool activation remains unrestricted.

The selector shows the scope you are editing. A disabled tool in **Global default** can still be allowed by a higher-priority model or session selection. Save with **Ctrl+S** before testing the change.

To disable model access through MCP, exclude every MCP gateway and direct tool, including `mcp`, `mcpScript`, and any individual server tools. Disabling only a direct tool does not prevent an enabled gateway from calling the same service. These choices do not unload extensions, stop background work, or disconnect servers. They are not a security sandbox.

If reading defaults fails, Pi reports the error and retains the last successfully applied selection. If no selection has been loaded yet, runtime tools remain unchanged. Fix the settings error before relying on the exclusions.

## Storage and WebUI compatibility

Global and model selections use the shared resource defaults in `~/.pi/webui/settings.json`. Session selections use `webui-tools-config` entries on the active session branch. WebUI reads and writes the same data, but it does not register the TUI `/tools` command.

The extension preserves unrelated settings and uses the same settings lock protocol as WebUI when writing resource defaults.
