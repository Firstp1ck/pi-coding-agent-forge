import { MODEL_USAGE_TASKS, USAGE_SUMMARY_DIVIDER, USAGE_SUMMARY_HEADER, USAGE_SUMMARY_HEADING } from "../src/scope.ts";

export function usageSummaryFixture(choice = "Insufficient evidence", confidence = 0) {
  return `${USAGE_SUMMARY_HEADING}\n\n${USAGE_SUMMARY_HEADER}\n${USAGE_SUMMARY_DIVIDER}\n${MODEL_USAGE_TASKS.map(task => `| ${task} | ${choice} | Do not choose from synthetic fixtures; obtain task-specific comparative evidence first. | No live comparative source was fetched. | ${confidence}/100 |`).join("\n")}\n`;
}
