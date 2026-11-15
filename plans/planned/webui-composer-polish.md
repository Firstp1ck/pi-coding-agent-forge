# Compact composer toolbar polish

User requests visual improvement of More/Send and the model/effort row. Keep Pi tokens, gradients and all actions. This is CSS presentation work, not a new submission or model-selection workflow.

## Design and boundaries

- One compact two-row toolbar under the input. More stays left; primary Send/Queue message/Steer run stays right. Opening More puts its action grid on a separate full-width row, without stretching primary buttons or clipping nested menus.
- Model, Scoped models and Effort read as a related row of light, compact controls rather than large cards. Preserve full names through existing tooltips, clear focus/hover/disabled states and scope semantics. Session label may be visually de-emphasized. Touch targets remain usable; coarse-pointer controls retain44px minimum.
- Long model names, busy behavior choice, failure descriptions and narrow inspector layouts must wrap without horizontal overflow or inaccessible buttons. Current DOM, order preferences, picker callbacks, disabled states, drafts and run controls stay unchanged. Classic/phone/tablet appearance remains scoped out.
- Sol worker owns only public/focused-shell-adapter.css, public/focused-composer-controls.css and tests/browser/composer-toolbar-polish.spec.mjs under pi-package-webui. Parent will not edit those CSS files concurrently. Preserve already committed Settings gear rules. No JS/HTML/cache/docs/dependency changes by worker.

## Validation and review

Real disposable app at1440 and1100withProject inspector, short500px window, dark/light, idle and running, More closed/open/nested menus, model/scoped/effort clickability and draft preservation. Capture/inspect screenshots. Existing focused-composer-more and interaction-composer-controls suites retain assertions. Parent handles central integration, asset revisions, docs and at most two Sol review rounds. No provider or installed config mutation.
