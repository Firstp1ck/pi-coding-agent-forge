import { createHash } from "node:crypto";
import type { TaskState } from "./types.ts";

export const INPUT_CONFIRMATION_REQUIRED = "Uncorrelated input requires /reliability input confirm (or confirm <exact text> after reload). Confirmation establishes new authority, not proof of earlier delivery.";
export const MAX_INPUT_BYTES = 8_192;
export const inputTextHash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Historic queue guesses remain history, never current native command/confirmation authority. */
export function inputAuthorityBlockReason(state: TaskState): string | undefined {
  if (state.input_pause) return INPUT_CONFIRMATION_REQUIRED;
  const session = state.current_session;
  // Offline reducers without a native session keep their existing inspection semantics.
  if (session.lifecycle_identity !== "available") return state.task_identity.session_id ? "Current native input/session authority is unavailable; consequential work remains paused." : undefined;
  if (!session.session_id || session.session_id !== state.task_identity.session_id
    || !state.task_identity.session_anchor_entry_id || !session.branch_entry_ids.includes(state.task_identity.session_anchor_entry_id)) return "Task input authority belongs to a different session or missing branch anchor.";
  for (const instruction of [state.authoritative_instructions.original_user_request, ...state.authoritative_instructions.corrections]) {
    const receipt = session.input_authority_receipts?.find(item => item.entry_id === instruction.session_entry_id);
    if (!receipt || (instruction.origin !== "user-command" && instruction.origin !== "native-confirmation")
      || receipt.origin !== instruction.origin || receipt.task_id !== state.task_id || receipt.text_sha256 !== inputTextHash(instruction.text)
      || instruction.session_id !== session.session_id || !session.branch_entry_ids.includes(receipt.entry_id)) return "Task input has no current persisted command or native confirmation authority. Start a new explicit /reliability on <goal> task; historic input guesses cannot be certified retroactively.";
  }
  return undefined;
}
