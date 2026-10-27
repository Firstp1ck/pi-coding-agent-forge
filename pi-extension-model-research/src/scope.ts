export const MODEL_USAGE_TASKS = [
  "Coding and implementation",
  "Debugging, testing, and code review",
  "Architecture and planning",
  "Research and fact-checking",
  "Reasoning, mathematics, and problem-solving",
  "Data analysis",
  "Writing, editing, and summarization",
  "Creative writing and brainstorming",
  "Learning, tutoring, and explanation",
  "Translation and multilingual tasks",
  "Long-context and document analysis",
  "Images and multimodal tasks",
  "Tool use, agents, and automation",
  "Pi extensions and skill writing",
  "Everyday assistance and decision support",
] as const;

export const OVERALL_RESEARCH_TASK = `Compare the two selected models overall and determine when to use each across all major task families: ${MODEL_USAGE_TASKS.join("; ")}. Evaluate quality, correctness, reliability, instruction-following, context and modality support, tool use, speed, cost, and operational limits where evidence exists. End with precise task-by-task model choices, concrete conditions and trade-offs, evidence gaps, and confidence. Do not invent a winner or claim exhaustive coverage of every possible task.`;

export const USAGE_SUMMARY_HEADING = "## When to use each model";
export const USAGE_SUMMARY_HEADER = "| Task | Use | When and why | Evidence / uncertainty | Confidence |";
export const USAGE_SUMMARY_DIVIDER = "|---|---|---|---|---|";
export const INCONCLUSIVE_MODEL_CHOICES = ["Either", "Neither", "Insufficient evidence"] as const;

export function studyScope(task: string): string {
  return task === OVERALL_RESEARCH_TASK
    ? OVERALL_RESEARCH_TASK
    : `${OVERALL_RESEARCH_TASK}\nAdditional priorities (must not narrow the overall comparison): ${task}`;
}
