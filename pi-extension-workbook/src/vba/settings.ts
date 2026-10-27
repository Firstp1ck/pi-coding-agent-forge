import { parseBooleanFlag, resolveEnvValue, upsertEnvValue } from "@firstpick/pi-utils/env";
import { getAgentEnvPath } from "@firstpick/pi-utils/paths";

export const VBA_EDITING_SETTING = "PI_WORKBOOK_VBA_EDITING";

export function isVbaEditingEnabled(): boolean {
  return parseBooleanFlag(resolveEnvValue(VBA_EDITING_SETTING).value);
}

export function setPersistentVbaEditing(enabled: boolean): void {
  upsertEnvValue(getAgentEnvPath(), VBA_EDITING_SETTING, enabled ? "1" : "0");
}

export type VbaSettings = {
  isEnabled(): boolean;
  enableSession(): void;
};

export function createVbaSettings(): VbaSettings & { resetSession(): void } {
  let sessionEnabled = false;
  return {
    isEnabled: () => sessionEnabled || isVbaEditingEnabled(),
    enableSession: () => { sessionEnabled = true; },
    resetSession: () => { sessionEnabled = false; },
  };
}
