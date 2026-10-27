import { type ComparisonSubjects, type WorkflowRun } from "./types.ts";
import { INCONCLUSIVE_MODEL_CHOICES } from "./scope.ts";

export const MAX_SUBJECT_MODEL_CHARS = 200;
const CONTROL_OR_LINE_BREAK = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** Normalize user-supplied labels without resolving authors, availability, or workers. */
export function normalizeSubjects(value: unknown): ComparisonSubjects {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError("subjects: must contain exactly two model labels");
  const labels = value.map((label, index) => {
    if (typeof label !== "string" || CONTROL_OR_LINE_BREAK.test(label)) {
      throw new TypeError(`subjects[${index}]: must be a single-line string without control characters`);
    }
    const model = label.trim();
    if (!model || model.length > MAX_SUBJECT_MODEL_CHARS) {
      throw new TypeError(`subjects[${index}]: must contain 1 through ${MAX_SUBJECT_MODEL_CHARS} characters after trimming`);
    }
    return model;
  });
  if (labels[0].toLocaleLowerCase("en-US") === labels[1].toLocaleLowerCase("en-US")) {
    throw new TypeError("subjects: model labels must differ (case-insensitive)");
  }
  return Object.freeze([
    Object.freeze({ key: "a", model: labels[0] }),
    Object.freeze({ key: "b", model: labels[1] }),
  ]);
}

/** Persisted/output tuples must already be canonical; validation never repairs identity. */
export function validateSubjects(value: unknown): ComparisonSubjects {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError("subjects: must contain exactly two subjects");
  for (const [index, subject] of value.entries()) {
    if (!subject || typeof subject !== "object" || Object.getPrototypeOf(subject) !== Object.prototype
      || Object.keys(subject).length !== 2 || !Object.hasOwn(subject, "key") || !Object.hasOwn(subject, "model")
      || subject.key !== (index === 0 ? "a" : "b")) {
      throw new TypeError("subjects: must contain only {key, model} objects ordered a then b");
    }
  }
  const normalized = normalizeSubjects(value.map(subject => subject.model));
  if (value.some((subject, index) => subject.model !== normalized[index].model)) {
    throw new TypeError("subjects: model labels must already be trimmed");
  }
  return value as unknown as ComparisonSubjects;
}

/** Keep exact historical model IDs for legacy records, without rewriting them. */
export function comparisonSubjects(run: Pick<WorkflowRun, "subjects" | "targets">): ComparisonSubjects {
  return run.subjects ?? [
    { key: "a", model: run.targets[0].model },
    { key: "b", model: run.targets[1].model },
  ];
}

/** Disambiguate subject names that collide with the final table's inconclusive options. */
export function subjectChoiceLabels(subjects: ComparisonSubjects): readonly [string, string] {
  const ambiguous = subjects.some(subject => INCONCLUSIVE_MODEL_CHOICES.some(choice => choice.toLocaleLowerCase("en-US") === subject.model.toLocaleLowerCase("en-US")));
  return subjects.map(subject => `${ambiguous ? `Subject ${subject.key.toUpperCase()}: ` : ""}${escapeSubjectLabel(subject.model)}`) as [string, string];
}

/** Render a label as inert Markdown text, including inside a table cell. */
export function escapeSubjectLabel(model: string): string {
  return model.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]{}()!|~])/g, "\\$1");
}
