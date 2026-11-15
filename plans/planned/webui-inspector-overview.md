# Inspector, overview and menu refinement

## Outcome and classification

The user reports clipped right-panel tabs and tooltips, missing footer scoped models, awkward More expansion and native-looking dropdowns. They request Project/Activity tabs inside the inspector, its section selector in the header, and a dismissible T3-inspired overview at the conversation's top right. This is complex: new shell presentation crosses canonical view ownership, action targets, menus and preferences. Parent is integration owner. Use Sol/high workers and independent reviewers, at most two review rounds for this unit; no Anthropic.

## Decisions and invariants

- Keep Pi themes, feature owners, HTTP/SSE, server authorization and settings scopes. No backend replacement, dependency installation, real provider calls, installed configuration edits or unsupported T3-only actions.
- Project and Activity become two tabs at the top of the right inspector. Both use one native section selector directly in its header, styled as the header. Remove the horizontal topic strip and duplicate View label. Every existing section remains reachable. Header buttons provide Overview and Inspector access; remove the obsolete floating Control Deck toggles only in compact mode. Existing Classic/mobile controls remain available.
- Overview is a nonmodal floating card within the conversation, top right, with a close action and header toggle. It uses actual available Pi workspace/Git/runner/agent/context/usage summaries and existing guarded actions, not simulated T3 values. Missing capabilities have honest unavailable states. No new polling or expensive fetch on idle render. Closing/hiding the card does not stop resources. Default closed; browser-local preference may remember visibility. Keep Abort/End reachable and do not steal draft focus during updates.
- More reveals secondary actions immediately to its right in the same toolbar, with Send anchored at the right. When narrow, the action area may wrap internally or scroll without a visible track, while More/Send remain visible; actions must not become a second row below the primary toolbar. Saved ordering and keyboard/menus remain functional.
- Restore footer Model/scoped-picker access, including saved grouped layout and ordering, and return focus to the actual opener. Preserve composer shortcuts.
- All native dropdowns use Pi typography/colors/borders, including expanded pickers where supported. Use CSS customizable-select capability with native keyboard/events/option ownership retained; style the native fallback without changing semantics. Verify current Chromium support and explicitly document other engines as untested. Do not clone selection state or replace native change semantics.
- Tooltips escape clipped ancestors, remain above UI, fit viewport and work on keyboard focus. Use the existing shared tooltip owner where possible; do not show duplicate CSS pseudo tooltips.

## Work graph and exact ownership

1. Seed this plan and contracts, then parallel isolated Sol implementation:
   - A, inspector chrome: public/shell-workspace.mjs, public/shell-workspace.css, tests/browser/inspector-header.spec.mjs, tests/browser/shell-workspace.spec.mjs, tests/browser/activity-section-picker.spec.mjs. New optional callbacks onToggleOverview/onToggleInspector; new state overviewOpen; expose slots.overview inside conversation. Own Project/Activity tabs and unified header selector. Handoff handoffs/inspector-header-worker.md.
   - B, native select theme: public/themed-selects.css and tests/browser/themed-selects.spec.mjs only. No app/index/cache edits. Handoff handoffs/themed-selects-worker.md.
   - C, overview component: public/conversation-overview.mjs, public/conversation-overview.css and tests/browser/conversation-overview.spec.mjs only. Pure presentation API described below. Handoff handoffs/conversation-overview-worker.md.
2. Parent owns app.js, focused-shell-adapter.mjs/css, shell-preferences.mjs/tests, tooltip integration, More layout, footer access, real snapshot/action integration, existing actual-app fixture migrations, all cache/inventory/docs and integration conflicts. No overlap with running workers.
3. Central integration: actual disposable app checks, screenshots, affected unit/static/browser checks and package gate. Update old locators while retaining behavioral assertions.
4. Two fresh Sol/high reviewer outputs with distinct ownership/interaction angles; parent verifies/dispositions/fixes findings. Optional final round limited to accepted repairs. No third round. Final HTML evidence report, archive verified plan, update existing authorized PR38 with screenshots. No merge/deploy.

## Overview component contract

Export createConversationOverview({document,onClose,onAction}) -> {element,update,dispose}. update({open,title,context,sections,target}) where sections:[{id,label,items:[{id,label,value,detail?,actionId?,disabled?,reason?,progress?}]}]. progress is a finite percent clamped 0..100. Render text safely; preserve item DOM and focus by stable IDs across updates; emit onAction(actionId,target) using the latest rendered target. Parent owns action authorization/revalidation and data gathering. Nonmodal region labelled Conversation overview, close button, optional section headings, compact rows/progress bars. Escape closes only when focus is in this card and the event is unhandled. Hidden/inert/disposed controls cannot dispatch. Width about 288px bounded to available conversation width/height; own vertical content scrolling only as needed. No resource calls, persistence, timers or session mutation inside component.

## Acceptance and rollback

At 1440/1100 and constrained conversation widths, inspector and header controls fit without horizontal navigation scrolling; all sections remain reachable. More's expanded actions begin beside its button, Send remains usable in short windows with suggestions, saved order and nested menus survive. Footer scoped picker works from its real chip with draft/focus retained. Tooltips at bottom-left/top-right remain in viewport and above clipped containers. Native selects retain disabled/optgroup/keyboard/form/change behavior in light/dark and dialogs. Overview shows current data, guarded actions, close/reopen and tab/session replacement correctly, including unknown states, keyboard and 200% text. Settings/Classic/mobile fallback and stream continuity remain intact.

Use existing system Chromium and dependencies through isolated HOME/XDG/Pi/Git/npm fixtures. Capture and inspect screenshots, show them in chat. Report actual coverage and omissions. Reuse canonical modules and additive browser preference; Classic remains the rollback path. Do not infer a passing whole-suite or device result from selected tests. No feature is complete until integrated checks and review dispositions are recorded.
