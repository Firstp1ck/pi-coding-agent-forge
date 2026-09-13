# Code scope and validation contract

A bounded repair has one observable behavioral objective, allowed read/write paths, prohibited/shared paths, exact validation commands, and a stop path. Inspect existing mutation targets immediately before editing. For a partial read, only a unique exact replacement whose old text is wholly inside the receipt-bound inspected span is permitted; whole-file replacement needs a full current read.

Use validation as evidence only when the host observed the command, it is current for the changed workspace revision, and it maps to the criterion. A passing command does not prove unrelated behavior. A declared validation command or mapping does not permit shell execution: every shell command still needs current native-confirmed scope and a single-use native approval for its exact normalized effect. After two repair attempts for the same failure, pause and escalate rather than cycling through ungrounded patches.
