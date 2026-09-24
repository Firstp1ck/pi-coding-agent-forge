import { validateNativePlan } from "./update/native-jobs.mjs";

function invocation({ command, args }) {
  return [command, ...args].map((part) => JSON.stringify(String(part))).join(" ");
}

/** Only confirmed native commands may be shown in an apply confirmation. */
export function nativeUpdateConfirmationText(plan) {
  validateNativePlan(plan, plan?.digest);
  const targets = plan.targets.map((target) =>
    `${target.id}: ${target.packageName} ${target.beforeVersion} at ${target.installedRoot}\n` +
    `Effects: ${target.effectRoot}\nCommand: ${invocation(target.command)}`);
  return [
    ...targets,
    `Working directory: ${plan.context.cwd}`,
    `Pi agent directory: ${plan.context.agentDir}`,
    ...(plan.context.npmPrefix ? [`npm prefix: ${plan.context.npmPrefix}`] : []),
    ...(plan.refusals || []).map((item) => `Skipped: ${item}`),
    plan.warning,
    `Confirmation digest: ${plan.digest}`,
  ].join("\n");
}
