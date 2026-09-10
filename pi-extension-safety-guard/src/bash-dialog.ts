import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, visibleWidth } from "@earendil-works/pi-tui";
import { bashSelectionHint, bashSelectionSummary, formatBashPrompt, type BashPrompt } from "./bash-prompt.ts";

export async function showBashPrompt(ctx: ExtensionContext, prompt: BashPrompt): Promise<string | undefined> {
  const options = ["Block", ...prompt.choices.keys()];
  if (ctx.signal?.aborted) return undefined;
  if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
    return ctx.ui.select(`Safety Guard: bash approval\n\n${prompt.message}\n\n${bashSelectionSummary(prompt.choices)}`, options, { signal: ctx.signal });
  }

  let cleanup = () => {};
  try {
    return await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
      let offset = 0;
      let pageSize = 1;
      let maxOffset = 0;
      let settled = false;
      const finish = (choice?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        done(ctx.signal?.aborted ? undefined : choice);
      };
      const abort = () => finish();
      cleanup = () => ctx.signal?.removeEventListener("abort", abort);
      ctx.signal?.addEventListener("abort", abort, { once: true });
      // The signal can change between entering custom() and constructing the component.
      if (ctx.signal?.aborted) queueMicrotask(abort);

      const list = new SelectList(options.map((value) => ({ value, label: value })), options.length, {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", theme.bold(text)),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      list.onSelect = ({ value }) => finish(value);
      list.onCancel = () => finish();
      const hint = (id: Parameters<typeof keys.getKeys>[0]) => keys.getKeys(id).join("/");
      const wrap = (text: string, width: number) => new Text(text, 0, 0).render(width);

      return {
        render(width: number) {
          const columns = Math.max(1, Math.min(width, 100));
          const title = wrap(theme.fg("accent", theme.bold("Safety Guard: bash approval")), columns);
          const choices = list.render(columns);
          const selected = list.getSelectedItem()?.label ?? "Block";
          // Native lists truncate labels. Keep the complete selected scope visible on narrow terminals.
          const selection = visibleWidth(selected) + 4 > columns ? wrap(theme.fg("text", selected), columns) : [];
          const choice = prompt.choices.get(selected);
          const scopeHint = wrap(theme.fg(choice?.lifetime ? "warning" : "muted", bashSelectionHint(choice)), columns);
          const help = wrap(theme.fg("dim", `${hint("tui.select.up")}/${hint("tui.select.down")} choose  ${hint("tui.select.confirm")} select  ${hint("tui.select.cancel")} block`), columns);
          const body = wrap(formatBashPrompt(prompt, theme), columns);
          const scrollHint = wrap(theme.fg("muted", `${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")} scroll details`), columns);
          const available = Math.max(1, tui.terminal.rows - title.length - choices.length - selection.length - scopeHint.length - help.length - 5);
          const scrolling = body.length > available;
          pageSize = Math.max(1, available - (scrolling ? scrollHint.length : 0));
          maxOffset = Math.max(0, body.length - pageSize);
          offset = Math.min(offset, maxOffset);
          return [
            ...title, "", ...body.slice(offset, offset + pageSize),
            ...(scrolling ? scrollHint : []), "", ...choices, ...selection, ...scopeHint, ...help,
          ];
        },
        invalidate() { list.invalidate(); },
        handleInput(data: string) {
          if (keys.matches(data, "tui.select.cancel")) finish();
          else if (keys.matches(data, "tui.select.pageUp")) offset = Math.max(0, offset - pageSize);
          else if (keys.matches(data, "tui.select.pageDown")) offset = Math.min(maxOffset, offset + pageSize);
          else list.handleInput(data);
          tui.requestRender();
        },
        dispose() { cleanup(); },
      };
    });
  } finally {
    cleanup();
  }
}
