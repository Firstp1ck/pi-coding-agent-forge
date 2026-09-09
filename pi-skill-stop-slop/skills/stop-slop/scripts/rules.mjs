// Pattern vocabulary adapted from Hardik Pandya's MIT-licensed stop-slop.
// See ../references/upstream/PROVENANCE.json and the package LICENSE.
export const RULESET_VERSION = '1.0.0';
export const MAX_BYTES = 1024 * 1024;

export const CATEGORIES = Object.freeze({
  formulaic: { weight: 20, label: 'Formulaic phrases' },
  rhetoric: { weight: 15, label: 'Formulaic rhetoric' },
  repetition: { weight: 15, label: 'Repeated openings and transitions' },
  adverbs: { weight: 10, label: 'Adverb candidates' },
  punctuation: { weight: 10, label: 'Em dashes' },
  rhythm: { weight: 10, label: 'Sentence-length uniformity' },
  passive: { weight: 10, label: 'Passive-voice candidates' },
  vague: { weight: 10, label: 'Vague emphasis and extremes' },
});

const rule = (id, category, name, kind, points, suggestion, phrases = []) =>
  Object.freeze({ id, category, name, kind, points, suggestion, phrases: Object.freeze(phrases) });

export const RULES = Object.freeze([
  rule('SLP001', 'formulaic', 'Filler or announcement', 'literal', 12,
    'Try starting with the fact rather than announcing it.', [
      "here's the thing", "here's what", "here's this", "here's that", "here's why",
      'the uncomfortable truth is', 'it turns out', 'let me be clear', 'the truth is',
      "i'll say it again", "i'm going to be honest", 'can we talk about',
      "here's the problem though", 'at its core', "in today's", "it's worth noting",
      'it is worth noting', 'it is important to note', "it's important to note",
      'at the end of the day', 'when it comes to', 'in a world where', 'the reality is',
      'in order to', 'due to the fact that',
    ]),
  rule('SLP002', 'formulaic', 'Business jargon candidate', 'heuristic', 6,
    'Use the concrete action or a plain word if the phrase adds no precision.', [
      'navigate challenges', 'navigate uncertainty', 'unpack', 'lean into', 'landscape',
      'game-changer', 'game changer', 'double down', 'deep dive', 'take a step back',
      'moving forward', 'circle back', 'on the same page',
    ]),
  rule('SLP003', 'formulaic', 'Meta-commentary', 'literal', 10,
    'Remove the preview if the next sentence already gives the reader the point.', [
      'hint:', 'plot twist:', 'spoiler:', 'you already know this, but',
      "but that's another post", 'a feature, not a bug', 'dressed up as',
      'the rest of this essay', 'let me walk you through', "in this section, we'll",
      "as we'll see", 'i want to explore',
    ]),
  rule('SLP004', 'vague', 'Performative emphasis', 'literal', 10,
    'Keep the fact or reason; consider removing the demand for emphasis.', [
      'full stop.', 'period.', 'let that sink in', 'this matters because',
      'make no mistake', 'creeps in', 'i promise', 'actually matters',
      'this is genuinely hard',
    ]),
  rule('SLP010', 'rhetoric', 'Binary contrast', 'heuristic', 12,
    'Try stating the positive claim directly. Keep contrasts that convey a real distinction.'),
  rule('SLP011', 'rhetoric', 'Negative listing', 'heuristic', 12,
    'Consider naming what it is without a sequence of things it is not.'),
  rule('SLP012', 'rhetoric', 'Rhetorical setup', 'heuristic', 8,
    'State the point without the setup unless the question serves the reader.', [
      'what if', "here's what i mean", 'think about it', "and that's okay",
    ]),
  rule('SLP013', 'rhetoric', 'Wh- sentence opening', 'heuristic', 3,
    'Check for repeated question-like setups. Keep genuine questions and useful conditions.'),
  rule('SLP014', 'rhetoric', 'Stacked short fragments', 'heuristic', 8,
    'Check whether these short statements need to be separate sentences.'),
  rule('SLP015', 'rhetoric', 'False-agency phrase', 'heuristic', 6,
    'Name the actor when it matters; do not invent one.', [
      'a complaint becomes a fix', 'a bet lives or dies', 'the decision emerges',
      'the culture shifts', 'the conversation moves toward', 'the data tells us',
      'the market rewards', 'nobody designed this', 'people tend to',
    ]),
  rule('SLP020', 'adverbs', 'Adverb candidate', 'heuristic', 0,
    'Check whether this modifier adds needed meaning. A suffix is not a part-of-speech parse.'),
  rule('SLP021', 'vague', 'Vague declarative or intensifier', 'heuristic', 12,
    'Name the specific effect or cite existing evidence. Never make up a measurement.', [
      'the reasons are structural', 'the implications are significant',
      'this is the deepest problem', 'the stakes are high', 'the consequences are real',
      'significant improvement', 'significantly improves', 'seamlessly integrates',
      'fundamental shift', 'overall experience',
    ]),
  rule('SLP022', 'vague', 'Absolute-word candidate', 'heuristic', 3,
    'Verify the scope of the claim. Keep exact requirements and justified absolutes.'),
  rule('SLP030', 'punctuation', 'Em dash', 'literal', 0,
    'Consider a period or comma. Keep the dash if the requested house style calls for it.'),
  rule('SLP040', 'repetition', 'Repeated transition', 'statistic', 0,
    'Remove repeated connectors where the relationship between sentences is already clear.'),
  rule('SLP041', 'repetition', 'Repeated sentence opening', 'statistic', 0,
    'Check the repeated openings without replacing necessary terms with arbitrary synonyms.'),
  rule('SLP050', 'rhythm', 'Uniform sentence lengths', 'statistic', 0,
    'Check the rhythm of these sentences. Do not add filler just to change their lengths.'),
  rule('SLP060', 'passive', 'Passive-voice candidate', 'heuristic', 0,
    'Name the actor if known and relevant. Keep passive voice when the actor does not matter.'),
]);

export const ADVERBS = new Set([
  'really', 'just', 'very', 'quite', 'rather', 'too', 'often', 'perhaps',
  'maybe', 'also', 'almost', 'already', 'still', 'even', 'only',
]);
export const NON_ADVERB_LY = new Set([
  'apply', 'belly', 'bully', 'butterfly', 'comply', 'costly', 'cuddly', 'curly',
  'daily', 'deadly', 'early', 'elderly', 'family', 'fly', 'friendly', 'ghastly',
  'heavenly', 'holly', 'holy', 'homely', 'imply', 'jelly', 'jolly', 'likely',
  'lily', 'lively', 'lonely', 'lovely', 'monthly', 'multiply', 'nightly', 'oily',
  'only', 'ply', 'rally', 'rely', 'reply', 'silly', 'sly', 'supply', 'ugly',
  'unlikely', 'weekly', 'wily', 'woolly', 'yearly',
]);
export const EXTREMES = new Set(['every', 'always', 'never', 'everyone', 'everybody', 'nobody']);
export const TRANSITIONS = new Set([
  'additionally', 'furthermore', 'moreover', 'however', 'therefore', 'consequently',
  'meanwhile', 'nevertheless', 'nonetheless', 'thus', 'finally',
]);

export const BINARY_PATTERNS = [
  /\b(?:not|isn't|aren't|wasn't|weren't|is\s+not|are\s+not)\b[^.!?\n\0]{1,100}?(?:,\s*(?:but\b|it(?:'s|\s+is)\b)|\s+but\s+(?:also\s+)?|[.!]\s+(?:but\b|because\b|it(?:'s|\s+is)\b|they\s+are\b))[^.!?\n\0]{1,100}/g,
  /\bstops? being\b[^.!?\n\0]{1,100}?\band starts? being\b[^.!?\n\0]{1,100}/g,
  /\bdoesn't mean\b[^.!?\n\0]{1,100}?\bbut\b[^.!?\n\0]{1,100}/g,
  /\bis about\b[^.!?\n\0]{1,100}?\bbut not\b[^.!?\n\0]{1,100}/g,
  /\bit feels like\b[^.!?\n\0]{1,100}[.!]\s+it's actually\b[^.!?\n\0]{1,100}/g,
];

export const PASSIVE_PATTERN = /\b(?:am|is|are|was|were|be|been|being)\s+(?:(?:[a-z]+ly|not|never|also)\s+){0,2}(?:[a-z]{2,}ed|built|bought|brought|caught|chosen|done|drawn|driven|eaten|felt|found|given|grown|held|hidden|hit|kept|known|led|left|lost|made|met|paid|put|read|run|said|seen|sent|set|shown|sold|spent|taken|taught|thought|told|understood|won|written)\b/g;
