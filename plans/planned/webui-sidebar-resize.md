# Resizable session sidebar

User asks to resize the compact left session sidebar by dragging. Lightweight capability using the existing browser shell preferences.

- Add a visible-on-hover/focus right-edge separator with pointer capture and keyboard ArrowLeft/Right (10px, Shift50), Home/End limits and double-click reset to202px.
- Persist navigationWidth on completed drag or keyboard/reset in the existing browser record; no save on pointer movement. Bounds180–420px, additionally clamp presentation to preserve480px for main workspace when feasible. Preserve saved preferred width across viewport reductions. Escape/pointer cancellation restores start width. Failed preference writes restore the prior layout.
- Hide/inactivate handle in top navigation, collapsed navigation and disabled compact shell. Clean listeners/capture/observer on disposal. Do not change Classic/mobile layouts, session order, draft, scroll or model selection.
- Parent owns shell-navigation-resize.mjs, shell-workspace.mjs/css, focused-shell-adapter.mjs, shell-preferences.mjs and dedicated tests. Existing parallel workers own other files. Integrate assets/cache/docs after all workers settle.
- Verify pointer drag, persistence/reload, keyboard/cancel, min/max/viewport, top/collapse/Classic return and draft/focus. Inspect rendered screenshots. Sol review max two rounds alongside bounded remaining UI changes.

## Verification so far

Four actual-app Chromium cases pass (drag/release persistence/reload, cancellation, keyboard limits, constrained host width, narrow viewport fallback, top/Classic restoration, denied-storage rollback). Thirty-three shell, Activity and focus cases pass after adding the new module to their static fixture asset maps. Initial component run stopped because those fixture maps did not serve the new import; assertions retained. Twenty combined preference/model-order Node cases pass. Resized screenshot captured and inspected. Review and final cache/package checks remain pending.
