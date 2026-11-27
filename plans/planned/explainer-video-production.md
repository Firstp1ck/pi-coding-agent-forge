# Explainer video production improvements

Integration owner: parent Codex session. Status: core inspected; implementation wave 2 ready.

## Outcome and classification

Implement the six improvements agreed in chat and create an inspected playable sample MP4. Complex feature: it changes the storyboard contract, browser renderer, validation and local delivery pipeline in two meaningful implementation slices. User authorized local implementation and sample creation, not publication, installation, commits or pushes.

## Decisions and compatibility

- Keep Node 22+, Chromium and FFmpeg, with no npm dependencies or first-party dependency changes. Existing version-1 storyboards and default clip caption styling remain supported.
- Add optional step `section` with `kind` opening/chapter/closing, `title`, optional `body` and `credit`, optional nonnegative `fadeIn`/`fadeOut` seconds and `shade` in 0..1. Section steps retain an app image/scene, need no instructional caption, pause inputs and suppress focus overlays. Fade ramps must fit the hold. Closing may fade to black. Deterministic seeking remains mandatory.
- Add optional top-level `captionStyle: "two-line"`, with stable badge and text baselines. Continuity resets across section cards; ordinary consecutive captions keep continuity rules.
- Add optional step `focusFade` seconds for a coordinated caption/spotlight entrance. Add optional `avoid` array of existing rect forms for caption exclusion regions.
- Expose browser `window.__EV.inspect(t)` for layout inspection after seek. Output pixel geometry: `{time, section, caption: {rect:[x,y,w,h], textOverflow:boolean, opacity:number}|null, spotlights:[{rect:[x,y,w,h]}], avoid:[[x,y,w,h]]}`. This is shared between renderer checks and tests.
- Add `--check-layout` and a JSON check output option to rendering. Check actual rendered caption bounds/overflow, active spotlight/avoid overlap, continuity at ordinary cuts and seek-order independence. Report timestamped failures and return nonzero. Do not infer arbitrary dialogs; authors declare avoid regions.
- Add `--sheet-mode shots` alongside the existing 12-frame overview. Sample each shot's reading hold, paginate or expand with timestamp/title labels. Delivery contact sheets decode the final MP4.
- Add an assembly CLI using an existing visual master, optional supplied audio, storyboard chapters and a copy-ready description. One timeline generates chapter metadata and description timestamps. Verify final codec/dimensions/fps/frame count, audio duration within encoder/frame tolerance and chapter boundaries. Stage outputs and preserve existing delivery on failure. Reject input/output aliasing. External processes have bounds and cleanup.
- Provide a reusable episode brief/timing template with permissions, revision, language, fixture start/result, disclosure and per-command safety checks. Preserve documentation layers.
- Sample: a short full-app walkthrough with opening, chapter and closing, two-line numbered captions, motion, a modal/avoid region, visible changed result, original locally synthesized soundtrack and embedded chapters. Sources and delivered artifacts stay together under dev/videos/explainer-video-sample; a compact runnable source example may ship in the package. Do not copy private application data.

## Waves and ownership

1. Worker A, Claude Opus medium, shared tree sole writer. Own engine.js, player.html, scripts/lib/storyboard.mjs, core storyboard/render tests, references/storyboard.md, new references/episode-template.md. Implement sections, caption preset, focus entrance, avoid validation, inspect API and episode template. Handoff `handoffs/explainer-video-core.md`. Forbidden: renderer CLI, export CLI, other packages, plan and existing dev/verification.
2. Parent inspects A before worker B starts. Worker B, Claude Opus medium, shared tree sole writer. Own scripts/render.mjs, new local assembly/check helpers under scripts/, new delivery tests and new renderer check tests. May add browser helpers to player/engine only if essential to the agreed inspect interface and documented. Implement layout checks, shot contact sheets and assembly/verification. Handoff `handoffs/explainer-video-tools.md`. No edits to core validation rules without escalating.
3. Parent integrates, updates package version/docs, creates sample and renders/inspects it. Run affected full suite, strict examples, npm pack dry-run, routing fixtures, Markdown whitespace/links, encoded media probe and positive/negative checks.
4. Two fresh read-only implementation reviews, GPT Sol high and Claude Fable high. Gemini Neon high handles bounded unusual-input hypotheses within round 1. At most two rounds; round 2 only fixes/regressions under shared policy. Parent verifies and dispositions every finding before fixes.
5. Save self-contained HTML report under reports/explainer-video-production.html and mutually link it here. After verified completion move this plan to plans/archive/.

## Acceptance

- Old example and full existing package tests pass; new independent behavioral tests fail without the feature.
- Section title hold, suppression, handoff and final black frame verified via rendered/decoded frames. Caption preset maintains baselines across words and chapter changes.
- Layout checker passes sample and rejects a deliberately obstructed/overflowing caption; deterministic seeking checked.
- Shot sheet contains every sample step and timestamps; final movie has expected frame count, H.264, optional AAC soundtrack and correct chapters matching description. A stale/wrong-length master and invalid chapter input are rejected.
- New sample MP4, thumbnail or poster, contact sheet, description, storyboard, scenes and soundtrack source delivered; sample is labeled illustrative.
- README user changes, TECHNICAL commands/limitations and DEVELOPMENT contracts/tests updated. No new runtime dependency; version bumped for added package capabilities.
- Two worker outcomes, central checks, two independent reviews and all finding dispositions recorded. No GUI window opens; screenshots displayed in chat via supported image embedding.

## Risks and recovery

Font metrics vary by installed fonts; inspect actual Chromium layout. AAC introduces duration rounding; use explicit tolerances. Layout checks cannot prove the accuracy of recreated product behavior. Keep delivery source and master separate; output staging protects prior exports. Code rollback is removal of this uncommitted scoped diff; no stored user-data migration. Preserve pre-existing untracked dev/verification/.

## Evidence and progress

- Starting tree: only pre-existing untracked dev/verification/. Skill installed via symlink to this package. .gitignore already excludes handoffs/, reports/ and plans/archive/.
- Existing source examples inspected in template commit 839f8f4 and Pacsea 86ee3edf. Four project storyboards validate without errors, three with wording warnings.
- Report destination: [implementation report](../../reports/explainer-video-production.html).
- Worker A completed: handoffs/explainer-video-core.md. Inspected actual changes and browser tests; 46/46 tests reported passing, both strict examples pass and 22 old/new stills byte-identical. Accept additive inspect fields and opening/closing placement constraints. Outgoing crossfade caption inspection remains a documented limitation; full-app sample uses cuts.
- Parent tightened two-line preset to place the action and instruction on separate lines, matching the template/Pacsea layout, and updated its browser assertion. Must revalidate with integrated suite.
- Parent reran inspect.test.mjs: 4/4 pass after updating the glyph measurement to ignore block boxes in Range.getClientRects().
- Tool CLI contracts: render `--check-layout --report <json>` may run with `--no-video`; `--sheet-mode overview|shots`. Assembly `assemble.mjs <storyboard.json> --visual <mp4> --out <mp4> [--audio <file>] [--description <txt>] [--sheet <png>]`. Chapters accept explicit storyboard `chapters: [{start,title}]`, strictly increasing finite starts beginning at zero and before the end; otherwise derive from section steps plus zero if necessary. Default description goes next to output. Decode final delivery for its shot sheet. Export helpers reject stale/wrong-length masters and audio gaps, preserve prior outputs on validation/process failure, and document tolerance.
