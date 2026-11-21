# Domain terms and durable decisions

Use this reference when a requirement depends on disputed or overloaded terms, or when design work establishes a consequential domain decision. This is additional workflow guidance, not a claim from the requirements-method source cited elsewhere in this package.

## Discover and sharpen the language

Read the project's glossary and relevant ADRs using its existing layout. A glossary map may point to different contexts; the same word can legitimately have different meanings in them. Do not impose new filenames or rename established records merely to match an example.

For a disputed term, record the competing meanings and source. Propose a precise term and test it with a concrete scenario. For example, distinguish cancelling one order line from cancelling an entire order. Check related code and tests when available, but treat them as current implementation evidence, not proof of business intent.

Ask the responsible user/stakeholder to resolve consequential ambiguity. Mark a proposed meaning as provisional until agreed. A glossary must not silently turn a solution proposal into an approved requirement.

## Capture only what needs to persist

When saving is authorized, update the existing glossary as meanings settle. Keep it about domain meaning and relationships, not a second requirements register or an implementation scratchpad. Cross-reference existing requirement and decision IDs rather than restating their full content.

If no glossary exists, propose a small repository-owned document when there are useful terms to retain. Create it only within the user's authorized writing scope. Read-only interviews and reviews can return proposed entries in chat.

Offer an ADR for a decision when reversal is meaningfully costly, the choice would surprise a future maintainer, and real alternatives had different consequences. Record context, alternatives, the decision and its authority/status, consequences, and a revisit trigger. Use the project's format and preserve superseded decisions rather than rewriting history.

Domain terminology alone does not justify an ADR. A routine naming cleanup or easily reversible local implementation choice usually belongs in code or the task record.

## Verification

Check that the agreed meaning is consistent across affected requirements, examples, and relevant code/test names. Surface mismatches with their sources rather than changing them all automatically. When terminology changes the intended behavior, use the requirement-change process and its approval boundaries.
