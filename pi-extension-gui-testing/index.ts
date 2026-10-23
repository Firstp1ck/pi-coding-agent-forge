import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Extension entry point for GUI testing.
 *
 * Registers no tools or commands yet. The setup commands and `gui_*` tools are
 * added milestone by milestone as described in
 * `plans/planned/gui-testing-spec.md`. Per the Pi extension contract, this
 * factory must not start processes, sockets, watchers, or timers.
 *
 * @param _pi Pi extension API for the current runtime.
 */
export default function guiTesting(_pi: ExtensionAPI): void {}
