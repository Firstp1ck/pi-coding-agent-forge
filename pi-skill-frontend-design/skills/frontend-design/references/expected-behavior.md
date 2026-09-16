# Expected interface behavior

[Back to the skill](../SKILL.md)

Use this reference before implementing an interface. Select the categories and examples that match the task. Do not add every pattern to every screen.

## What counts as implicit

An implicit requirement is supporting behavior needed to make the requested feature work as a person reasonably understands it. A Save button implies an actual save, accurate feedback, and a way to recover if saving fails. It does not imply cloud sync, version history, or autosave.

Use three working categories. They are a practical decision aid, not a formal industry taxonomy:

1. **Baseline usability** applies to the content and controls being built. People can read, understand, reach, and operate them using supported input methods.
2. **Feature-dependent expectations** apply only when the feature is present. A modal needs focus management. An asynchronous search needs result freshness. A form needs error recovery.
3. **Product decisions** change what the product does or promises. Follow existing requirements or ask when unresolved. Do not infer pricing, permissions, retention periods, new storage, external communications, or transaction policies from a visual brief.

Prefer evidence in this order: explicit requirements, established product behavior and domain constraints, platform and accessibility conventions, then the smallest reversible assumption. A convention does not override a safety constraint. If the existing product has an accessibility or data-loss defect, identify and fix it within scope rather than copying it blindly.

## Trigger-based behavior checklist

These are defaults for working interfaces, not a demand to expand a static mockup into an application. Preserve the project's supported platforms and stated accessibility target. The accessibility examples below are not a complete WCAG audit.

| When the interface includes... | Expected supporting behavior | Boundary to preserve |
| --- | --- | --- |
| Links and navigation | Use links for destinations and buttons for actions. Preserve normal link behavior, browser Back and Forward, and a clear current location. Keep relevant list context when returning from a detail view. | Follow existing routing conventions. Do not put sensitive values in URLs or invent persistence across sessions. |
| Forms and settings | Load actual values; distinguish unavailable data from blank defaults. Give inputs persistent labels, instructions, appropriate types and autocomplete where suitable. Allow paste and password managers. Associate errors with fields and preserve entered values after a recoverable failure. | Do not invent validation or eligibility rules. Client validation is not server validation. Do not store sensitive drafts merely to survive a reload. |
| Save, send, or other writes | Show pending, success, and failure truthfully. Prevent repeated activation while the same action is pending. Keep unsaved edits recoverable. Use confirmed results for completion claims; reconcile optimistic updates on failure. | Disabling a button is not backend deduplication. Do not blindly retry a write whose outcome is unknown or claim success from a timer. |
| Loading data | Distinguish loading, empty, error, and populated states. Give recoverable errors a useful next action. Keep previously loaded content when useful and clearly identify stale or refreshing content. Avoid abrupt layout shifts. | A failed request is not an empty result. A zero is a value, not a substitute for unavailable data. Do not invent progress percentages. |
| Search, filters, sorting, or pagination | Keep controls consistent with the displayed results. Expose active filters and a clear/reset action. Distinguish no matches from an empty collection. Ignore superseded responses; reset or clamp pagination when filtering invalidates the current page. | Follow product conventions for URL state and history. Do not add pagination, fuzzy search, saved searches, or new filter capabilities without need. |
| Dialogs, menus, tabs, or popovers | Prefer existing accessible components. Use the appropriate pattern's semantics and keyboard behavior. A modal needs an accessible name, appropriate initial focus, contained Tab navigation, Escape dismissal, and focus return to the trigger or a logical successor. | A non-modal popover must not trap focus like a modal. Do not add ARIA roles without their behavior. Closing a dialog must not silently discard significant edits. |
| Destructive or high-consequence actions | Name the affected item and consequence. Use supported undo for recoverable actions or a proportionate confirmation for irreversible/high-impact actions. Provide a safe exit and accurate completion feedback. | Do not require confirmation for every harmless change. Do not offer Undo without real restoration support or infer permission to delete production data. |
| Uploads, dragging, or reordering | Offer a file picker or non-drag action. Explain supported types and limits from the actual service. Preserve successful items when others fail. Report per-item progress or indeterminate activity honestly. | Do not promise cancellation, resumable uploads, background processing, or retry safety unless supported. Client file checks are not a security boundary. |
| Responsive layouts and varied input | Keep essential actions usable on narrow screens, with zoom, long text, and empty or large datasets. Support keyboard access, readable contrast, visible and unobscured focus, and usable pointer targets. Respect reduced motion. Provide alternatives to hover-only information and drag-only actions. | Do not remove essential functionality on mobile. A wide data table may need its own labeled horizontal scrolling region; do not force all content into a misleading card layout. |
| Status, permissions, and live updates | Expose relevant status changes to assistive technology without stealing focus for every update. Explain unavailable actions safely. Preserve current work when data refreshes; use existing conflict handling rather than silently overwriting edits. | Hidden or disabled UI is not authorization. Do not reveal private records through error messages or fabricate role and conflict-resolution rules. |

Use native HTML first and established project components next. Custom controls inherit the interaction obligations of the pattern they represent. A styled `div` does not become a working button just because it has a click handler.

## Application examples

These are realistic application scenarios, not claims about a particular vendor's implementation. Each example separates necessary supporting behavior from optional product expansion. Adapt the checks to the actual application and backend.

### Workspace notification settings

**Brief:** "Build the notification settings page for our project-management app."

The page edits email frequency and project alerts using the existing settings service and explicit Save behavior.

Expected behavior:

- Load the stored preferences before presenting them as editable truth. If loading fails, offer recovery rather than showing unchecked defaults that could overwrite real settings.
- Label each setting and show dependent controls consistently with the product's existing rules. Save the user's changes, prevent duplicate submission, and confirm success only after the service confirms it.
- On failure, retain the edited values and identify the failed save. Cancel restores the last confirmed settings, not hard-coded defaults.
- Protect significant unsaved changes on in-app navigation using the existing application's approach. Warn only when work is at risk. A browser unload prompt is not a reliable substitute for draft recovery on every platform.

Acceptance checks:

- Given saved weekly emails, when the page loads, weekly is selected. After changing to daily and forcing a save failure, daily remains editable, an error appears, and no "Saved" message appears.
- After a successful save, reload and confirm daily is still selected. Keyboard users can reach every setting and receive the save result.

Do not infer autosave, cross-device sync, browser draft storage, or a new email-delivery service. If the application already uses autosave, preserve that contract instead of adding a conflicting Save button.

### Storefront product search

**Brief:** "Add size and availability filters to the shoe catalog."

The catalog already has search, product detail routes, and paginated results.

Expected behavior:

- Keep the selected sizes, availability filter, count, and results consistent. Provide Clear filters. Return to a valid page when the previous page no longer exists.
- Distinguish "No shoes match these filters" from "Products could not be loaded." Keep filter selections after a failed request.
- If an older request finishes after a newer one, it must not replace the newer results. Do not move focus away from the search input on every update.
- Preserve useful catalog context when opening a product and returning. If the app already stores filters in the URL, keep links, reload, and Back/Forward consistent with that convention.

Acceptance checks:

- Delay the response for size 8, select size 9, then let size 8 finish last. Size 9 remains selected and its results remain visible.
- Filter from the last page to a single matching product. The product appears on a valid page rather than under a false no-results message. Clear filters restores the unfiltered view.

Do not infer saved searches, personalized recommendations, new inventory rules, or a requirement to put every keystroke into browser history.

### Cinema ticket checkout

**Brief:** "Finish the checkout for selected seats and customer details."

The application already supplies seat availability, booking rules, prices, and a payment integration.

Expected behavior:

- Keep the film, screening date and time, seats, currency, and full known price visible before the commitment. Explain any authoritative availability or price change before proceeding.
- Preserve non-sensitive entered details when validation fails. Link errors to the affected inputs and offer a clear correction path.
- Prevent repeat activation while booking is pending. Distinguish a confirmed booking, a declined transaction, and an unknown outcome after a connection failure.
- When the outcome is unknown, use the existing booking-status or payment-reconciliation flow before offering another charge. Display confirmation only from an authoritative result.

Acceptance checks:

- Double-activate the booking action and verify the frontend initiates only one submission while pending. Test the actual transaction guarantees separately; the button alone cannot guarantee exactly-once charging.
- Simulate a lost response after submission. The UI does not say "Payment failed, try again" as though no charge occurred. It explains that confirmation is pending and provides the supported status-check or support path.
- Simulate a seat becoming unavailable. The UI explains which selection needs attention and retains safe customer details.

Do not invent seat-hold duration, refund terms, fees, payment retry policy, or storage of payment credentials. Missing backend reconciliation is a dependency to report, not something a success screen can solve.

### Team administration and member removal

**Brief:** "Add a remove-member action to the team table."

The service already defines who may remove members and what removal does.

Expected behavior:

- Identify the member and workspace in the action and confirmation. Explain the actual consequence without implying that account deletion and workspace removal are the same thing.
- Use an accessible confirmation dialog for a consequential removal. Put initial focus on a safe choice when appropriate, contain keyboard focus, support Escape, and return focus sensibly.
- Keep the member visible if removal fails. After success, move focus to a logical remaining row action or table heading if the original trigger disappeared.
- Reflect known permission limits in the UI and handle a server rejection if permissions changed. The server remains authoritative.

Acceptance checks:

- Open and cancel the dialog using only the keyboard. No removal occurs and focus returns to the initiating action.
- Confirm removal and force a permission failure. The row remains, the error is understandable, and no success notice appears.

Do not infer bulk removal, an undo promise, role policy, or automatic email notifications. Do not add a confirmation dialog to every harmless table action.

### Digital asset uploads

**Brief:** "Build the file upload panel for a shared asset library."

The service supplies upload limits and accepts multiple files.

Expected behavior:

- Support file selection as well as drag and drop. Show filenames, size/type issues, and the status of each selected file.
- Keep a successful upload when another fails. Make it clear which file can be retried and avoid resubmitting successful files.
- Distinguish bytes uploaded from server-side processing if both exist. Use an indeterminate indicator when actual progress is unavailable.
- Give removal and cancellation distinct meanings. Removing a file from the visible queue does not prove an in-flight upload stopped or that a stored file was deleted.

Acceptance checks:

- Select one valid and one oversized file using the file picker. The valid file remains usable and the rejected file receives an actionable error.
- Fail one upload after another succeeds. Recovery targets only the failed file. If a timeout leaves the result unknown, follow the existing duplicate-detection or status-check behavior before retrying.

Do not infer resumable transfer, indefinite retention, public sharing, automatic compression, or background continuation after leaving the page.

### Task board with drag-and-drop movement

**Brief:** "Let users move tasks between board columns."

The board already has a move operation and defined workflow states.

Expected behavior:

- Provide a reachable "Move to" menu or equivalent non-drag control that works with both keyboard and simple pointer input. Keyboard support alone does not provide a click/tap alternative to dragging.
- Keep task labels and allowed destinations clear. Preserve focus on the moved task or a logical successor and announce the result without unnecessary focus jumps.
- If movement is optimistic, restore or reconcile the previous state when the save fails. Do not leave a card visually moved when the application knows the move was rejected.
- Use existing conflict behavior when another user changes the task. Do not silently overwrite a known newer state.

Acceptance checks:

- Move a task using only the keyboard, then repeat using click/tap controls without dragging. Both paths reach the same allowed destination.
- Reject the move at the service. The card returns to its confirmed state or a clearly explained recoverable state, with no false success message.

Do not infer new workflow states, offline synchronization, arbitrary reordering within columns, or permission to override a conflict.

## Turn expectations into evidence

For each relevant task, record a short acceptance check in this shape:

> Given the starting state, when the user takes an action, then the observable result occurs. If the reachable failure happens, the user keeps the appropriate work and has a safe next action.

Prioritize misleading success, loss of work, inaccessible actions, duplicate side effects, and broken navigation before decorative polish. Use existing tests and browser tools to check those outcomes. Do not perform real charges, send messages, or delete user data as verification without authorization.

A screenshot can show layout and visible states. It cannot establish keyboard behavior, persistence, request ordering, or recovery. If a check cannot run, report it as unverified rather than silently treating it as passed.

## Sources and interpretation

The categories, application scenarios, request-ordering advice, and scope rules above are this skill's engineering synthesis. They are not all WCAG requirements. The following references support particular parts of the guidance:

- [Nielsen Norman Group: 10 usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) supports system-status feedback, user control, consistency, error prevention, and recovery. These are evaluation heuristics, not a feature list every application must implement.
- [GOV.UK: Recover from validation errors](https://design-system.service.gov.uk/patterns/validation/) and [Error message](https://design-system.service.gov.uk/components/error-message/) support useful validation feedback and preserving both valid and invalid entered answers. Their exact component presentation is specific to that design system.
- [W3C WAI APG: Modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) describes modal focus placement, keyboard containment, Escape dismissal, and focus return, including exceptions when the original trigger no longer exists. It is pattern guidance, not a mandate to turn every popup into a modal.
- [W3C: Understanding status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) explains programmatically exposing status messages without requiring them to receive focus. Do not announce every keystroke or use assertive announcements for routine updates.
- [W3C: Understanding reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow) explains narrow/zoomed content and exceptions for content requiring a two-dimensional layout, such as some data tables.
- [W3C: Understanding dragging movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) explains the single-pointer alternative to dragging, which is distinct from keyboard accessibility.

The W3C Understanding documents explain success criteria; they are informative guidance, not the normative standard itself. Check the project's full accessibility requirements rather than claiming conformance from this checklist.
