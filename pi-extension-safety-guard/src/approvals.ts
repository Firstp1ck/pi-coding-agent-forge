import path from "node:path";

export type BashRuleGrant = {
  id: string;
  label: string;
};

const BRANCH_CREATION: BashRuleGrant = {
  id: "git.switch.create.v1",
  label: "git switch branch creation",
};

/** Broader grants require a complete, literal command, never a substring match. */
export function bashRuleGrant(command: string): BashRuleGrant | undefined {
  if (/[\r\n]/.test(command)) return undefined;
  // No flags, start point, quoting, expansion, redirection, or shell operators.
  const match = /^[ \t]*git[ \t]+switch[ \t]+(?:-c|--create)[ \t]+[A-Za-z0-9][A-Za-z0-9._/-]*[ \t]*$/.exec(command);
  if (match?.[0] !== command) return undefined;
  return { ...BRANCH_CREATION };
}

export function ruleAllowKey(ruleId: string, cwd: string): string {
  return `rule:${JSON.stringify(["bash", path.resolve(cwd || process.cwd()), ruleId])}`;
}

export function isKnownBashRuleId(value: unknown): value is string {
  return value === BRANCH_CREATION.id;
}

export type OperationRule = BashRuleGrant & { description: string };
const OPERATION_RULES = {
  create: {
    id: "git.switch.create.operation.v1",
    label: "Git branch creation",
    description: "git switch -c/--create <simple branch>: any branch name; changes checkout and may run hooks; no extra flags or start point",
  },
  switch: {
    id: "git.switch.existing.operation.v1",
    label: "Git branch switching",
    description: "git switch <simple branch>: any branch name; changes checkout and may run hooks; no force or other flags",
  },
  deleteMerged: {
    id: "git.branch.delete-merged.operation.v1",
    label: "Git merged-branch deletion",
    description: "git branch -d <simple branch>: any branch name; deletes a local branch only when Git permits -d; never -D or extra flags",
  },
} satisfies Record<string, OperationRule>;

export function operationRule(argv: readonly string[]): OperationRule | undefined {
  const simpleBranch = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.exec(value)?.[0] === value;
  if (argv[0] !== "git") return undefined;
  if (argv.length === 4 && argv[1] === "switch" && ["-c", "--create"].includes(argv[2]) && simpleBranch(argv[3])) return { ...OPERATION_RULES.create };
  if (argv.length === 3 && argv[1] === "switch" && simpleBranch(argv[2])) return { ...OPERATION_RULES.switch };
  if (argv.length === 4 && argv[1] === "branch" && argv[2] === "-d" && simpleBranch(argv[3])) return { ...OPERATION_RULES.deleteMerged };
  return undefined;
}

export function isKnownOperationRuleId(value: unknown): value is string {
  return Object.values(OPERATION_RULES).some((rule) => rule.id === value);
}

export function operationAllowKey(argv: readonly string[], cwd: string): string {
  return `operation:${JSON.stringify(["bash", path.resolve(cwd || process.cwd()), argv])}`;
}

export function globalOperationAllowKey(argv: readonly string[]): string {
  return `operation-global:${JSON.stringify(["bash", argv])}`;
}

export function operationRuleAllowKey(id: string, cwd: string): string {
  return `operation-rule:${JSON.stringify(["bash", path.resolve(cwd || process.cwd()), id])}`;
}
