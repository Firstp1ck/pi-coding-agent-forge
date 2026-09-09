# Interpreting an evaluation

A rule match is a prompt to inspect a passage. It is not an instruction to delete it.

## What the evaluator measures

The checker reports eight penalty scores: formulaic phrases, rhetoric, repetition, adverbs, punctuation, rhythm, passive voice, and vague emphasis. Lower scores mean fewer detected patterns. Counts, rates, source spans, and rule IDs explain the result. Every run uses local fixed rules with no random input or model call.

Literal phrase and punctuation checks are exact matches within the evaluated prose. They can still flag useful language. Grammar and rhetorical rules are heuristics. They cannot reliably identify all adverbs, distinguish an adjective from a passive participle, or decide whether a contrast is justified.

Statistics describe the selected text. They do not set a writing ideal. Short samples carry warnings. Rhythm is not assessed before six sentences and 60 words; repeated openings need six sentences. A shorter revision may no longer qualify for those checks. That is not proof of improved rhythm.

## What stays outside the score

- Whether the text is true, sourced, safe, complete, or useful.
- Authorship, authenticity, personality, and “sounding human.”
- Whether a passive sentence, question, three-item list, or repeated term fits the situation.
- Whether the revision preserves the original meaning.

If you offer an editorial judgment on these questions, label it separately from the script's measured results. Do not add a model-generated authenticity score to the deterministic report.

## Review a comparison

1. Confirm that both texts used the same ruleset, format, and ignored rules. The CLI's baseline option does this by reanalyzing the original prose.
2. Check category deltas and individual rule counts, not only the total. A negative delta is a reduced penalty.
3. Inspect warnings and word-count changes. Deleting content, adding padding, or moving prose into code blocks can lower scores without improving writing.
4. Read the final text against the original. Check numbers, citations, quotations, instructions, caveats, and safety requirements.
5. Report measured changes and editorial exceptions separately. Stop rather than sacrificing meaning for a target.

## Relationship to upstream

The bundled upstream documents preserve Hardik Pandya's wording. This adaptation does not enforce every absolute prohibition. It treats grammar and context-sensitive phrases as candidates and leaves exceptions to the writer.

Upstream's subjective directness, rhythm, trust, authenticity, and density ratings are not the evaluator's scores. Its examples also contain tensions with its rules: one revised example uses an em dash, and others cut details from the original. Keep them as historical examples, not semantic-preservation tests or a second scoring policy.
