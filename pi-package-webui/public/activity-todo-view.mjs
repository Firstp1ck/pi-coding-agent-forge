/** Renders the existing todo projection; session expansion and live data stay with the caller. */
export function createActivityTodoView({ document, stripAnsi, parseItem }) {
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function parse(lines) {
    const cleanLines = lines.map(stripAnsi).map((line) => line.trim()).filter(Boolean);
    const goalLine = cleanLines.find((line) => /^Goal\s*[:：]/i.test(line));
    const goal = goalLine ? goalLine.replace(/^Goal\s*[:：]\s*/i, "").trim() : "";
    const headerIndex = cleanLines.findIndex((line) => /^Todo\s+\d+\/\d+\s+done/i.test(line));
    if (headerIndex === -1) return null;

    const header = cleanLines[headerIndex];
    const match = header.match(/^Todo\s+(\d+)\/(\d+)\s+done(?:,\s+(\d+)\s+partial)?/i);
    if (!match) return null;

    const items = [];
    let footer = "";
    for (const line of cleanLines.slice(headerIndex + 1)) {
      const item = parseItem(line);
      if (item) {
        items.push(item);
      } else if (/^Scroll\s+/i.test(line)) {
        footer = line;
      }
    }

    return {
      goal,
      done: Number.parseInt(match[1], 10) || 0,
      total: Number.parseInt(match[2], 10) || items.length,
      partial: Number.parseInt(match[3] || "0", 10) || 0,
      items,
      footer,
    };
  }

  function render(lines, { expanded = false, onExpandedChange = () => {} } = {}) {
    const todo = parse(lines);
    if (!todo) return null;

    const node = make("details", "widget todo-widget");
    node.open = expanded === true;
    node.setAttribute("aria-label", "Todo progress");
    node.addEventListener("toggle", () => {
      onExpandedChange(node.open);
    });

    const percent = todo.total > 0 ? Math.max(0, Math.min(100, (todo.done / todo.total) * 100)) : 0;
    const summary = make("summary", "todo-widget-summary");
    const header = make("div", "todo-widget-header");
    header.append(
      make("span", "todo-widget-toggle", "›"),
      make("span", "todo-widget-title", "Todo progress"),
      make("span", "todo-widget-count", `${todo.done}/${todo.total}`),
      make("span", "todo-widget-meta", todo.partial ? `${todo.partial} partial` : "active"),
    );

    const progress = make("div", "todo-widget-progress");
    const fill = make("span", "todo-widget-progress-fill");
    fill.style.width = `${percent}%`;
    progress.append(fill);
    if (todo.goal) summary.append(make("div", "todo-widget-goal", `Goal: ${todo.goal}`));
    summary.append(header, progress);

    const body = make("div", "todo-widget-body");
    const list = make("ol", "todo-widget-list");
    for (const item of todo.items) {
      const row = make("li", `todo-widget-item ${item.status}`);
      row.append(
        make("span", "todo-widget-marker", item.status === "done" ? "✓" : item.status === "partial" ? "–" : ""),
        make("span", "todo-widget-text", item.text),
      );
      list.append(row);
    }
    if (todo.items.length) body.append(list);
    if (todo.footer) body.append(make("div", "todo-widget-footer", todo.footer));

    node.append(summary);
    if (body.children.length) node.append(body);
    return node;
  }

  return { parse, render };
}
