/**
 * Usage and loop check types (spec §8.1). The detector never blocks a tool call;
 * it only attaches a warning to the result and notifies the user.
 */

export type ToolName =
  | "gui_launch"
  | "gui_wait"
  | "gui_snapshot"
  | "gui_screenshot"
  | "gui_act"
  | "gui_logs"
  | "gui_stop"
  | "gui_export";

/** One completed tool call, fed to the detector in call order. */
export interface UsageEvent {
  session: string;
  tool: ToolName;
  /** Epoch milliseconds. */
  at: number;
  /** For `gui_act`. */
  action?: string;
  ref?: string;
  x?: number;
  y?: number;
  /** SHA-256 of the screenshot taken by or after this call, if any. */
  screenshotSha256?: string;
  allBlack?: boolean;
  bytesSynced?: number;
}

export type LoopSignal = "repeated-action" | "unchanged-screen" | "launch-storm" | "session-cost" | "daily-cost";

export interface UsageWarning {
  signal: LoopSignal;
  /** Plain-language message for the model: stop and reassess. */
  message: string;
  /** Observed count or amount that crossed the threshold. */
  observed: number;
  threshold: number;
}

/** Thresholds from spec §8.1. */
export const LOOP_THRESHOLDS = {
  /** Same action on the same ref/coordinates more than this many times in a row. */
  repeatedAction: 5,
  /** More than this many consecutive actions with identical screenshot hashes. */
  unchangedScreen: 8,
  /** More than this many `gui_launch` calls ... */
  launchStorm: 20,
  /** ... within this window. */
  launchStormWindowMs: 10 * 60_000,
} as const;

export interface SessionUsage {
  session: string;
  backend: string;
  startedAt: number;
  toolCalls: Partial<Record<ToolName, number>>;
  actions: number;
  screenshots: number;
  allBlackScreenshots: number;
  bytesSynced: number;
  warnings: UsageWarning[];
}
