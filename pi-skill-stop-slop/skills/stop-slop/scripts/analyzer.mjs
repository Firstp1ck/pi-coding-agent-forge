import { createHash } from 'node:crypto';
import {
  ADVERBS, BINARY_PATTERNS, CATEGORIES, EXTREMES, MAX_BYTES, NON_ADVERB_LY,
  PASSIVE_PATTERN, RULES, RULESET_VERSION, TRANSITIONS,
} from './rules.mjs';
import { locator, maskProse, normalize, splitSentences, tokenize } from './text.mjs';

export { MAX_BYTES, RULES, RULESET_VERSION } from './rules.mjs';
const ruleById = new Map(RULES.map(rule => [rule.id, rule]));
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
const cap = value => round(Math.min(100, Math.max(0, value)));
const percent = (count, total) => total ? round(count / total * 100) : 0;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrasePatterns = RULES.flatMap(rule => rule.phrases.map(phrase => ({
  id: rule.id,
  pattern: new RegExp(`(?<![\\p{L}\\p{N}_])${phrase.split(' ').map(escapeRegex).join('(?:[ \\t]+|[ \\t]*\\r?\\n[ \\t]*)')}(?![\\p{L}\\p{N}_])`, 'gu'),
})));

function optionsFor(options) {
  const { format = 'markdown', ignore = [], maxFindings = 200 } = options;
  if (!['markdown', 'text'].includes(format)) throw new TypeError('format must be markdown or text');
  if (!Array.isArray(ignore) || ignore.some(id => !ruleById.has(id))) {
    throw new TypeError('ignore must be an array of known rule IDs; use --rules to list them');
  }
  if (!Number.isInteger(maxFindings) || maxFindings < 0 || maxFindings > 10000) {
    throw new TypeError('maxFindings must be an integer from 0 to 10000');
  }
  return { format, ignore: [...new Set(ignore)].sort(), maxFindings };
}

export function analyze(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_BYTES) throw new RangeError(`input exceeds ${MAX_BYTES} UTF-8 bytes`);
  const settings = optionsFor(options);
  const ignored = new Set(settings.ignore);
  const masked = maskProse(source, settings.format);
  const normalized = normalize(masked);
  const words = tokenize(masked);
  const sentences = splitSentences(masked, words, source, settings.format);
  const findings = [];
  const seen = new Set();
  const add = (ruleId, start, end) => {
    if (ignored.has(ruleId)) return;
    const key = `${ruleId}:${start}:${end}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push({ ruleId, start, end });
    }
  };
  for (const { id, pattern } of phrasePatterns) {
    for (const m of normalized.matchAll(pattern)) add(id, m.index, m.index + m[0].length);
  }
  for (const pattern of BINARY_PATTERNS) {
    for (const m of normalized.matchAll(pattern)) add('SLP010', m.index, m.index + m[0].trimEnd().length);
  }
  for (const m of normalized.matchAll(/\b(?:not\s+(?:a|an|the)\b[^.!?\n\0]{1,100}[.!]\s*){2}|\bit (?:wasn't|isn't)\b[^.!?\n\0]{1,100}[.!]\s*it (?:wasn't|isn't)\b[^.!?\n\0]{1,100}/g)) {
    add('SLP011', m.index, m.index + m[0].trimEnd().length);
  }

  const adverbWords = words.filter(word => ADVERBS.has(word.value)
    || (/^[a-z]{3,}ly$/.test(word.value) && !NON_ADVERB_LY.has(word.value)));
  for (const word of adverbWords) add('SLP020', word.start, word.end);
  for (const word of words) if (EXTREMES.has(word.value)) add('SLP022', word.start, word.end);
  const emDashes = [...masked.matchAll(/—/g)];
  for (const m of emDashes) add('SLP030', m.index, m.index + 1);

  const passiveSentences = new Set();
  const openings = new Map();
  const transitions = new Map();
  let fragmentRun = [];
  const flushFragments = () => {
    if (fragmentRun.length >= 3) {
      const firstThree = fragmentRun.slice(0, 3);
      add('SLP014', firstThree[0].start, firstThree[2].words.at(-1).end);
    }
    fragmentRun = [];
  };
  for (const [index, sentence] of sentences.entries()) {
    const first = sentence.words[0];
    if (/^(what|when|where|which|who|why|how)$/.test(first.value)) add('SLP013', first.start, first.end);
    if (!openings.has(first.value)) openings.set(first.value, []);
    openings.get(first.value).push(first);
    if (TRANSITIONS.has(first.value)) {
      if (!transitions.has(first.value)) transitions.set(first.value, []);
      transitions.get(first.value).push(first);
    }
    // Do not join fragment sequences across paragraph breaks or code blocks.
    const previous = sentences[index - 1];
    const gap = previous ? masked.slice(previous.words.at(-1).end, sentence.start) : '';
    if (/\n[\t \r\0]*\n|\0/.test(gap)) flushFragments();
    if (sentence.words.length <= 3) fragmentRun.push(sentence);
    else flushFragments();
    for (const m of normalized.slice(sentence.start, sentence.end).matchAll(PASSIVE_PATTERN)) {
      add('SLP060', sentence.start + m.index, sentence.start + m.index + m[0].length);
      passiveSentences.add(index);
    }
  }
  flushFragments();

  let repeatedOpenings = 0;
  if (sentences.length >= 6) {
    for (const group of openings.values()) {
      if (group.length >= 3 && group.length / sentences.length >= 0.4) {
        for (const word of group.slice(1)) add('SLP041', word.start, word.end);
        repeatedOpenings += group.length - 1;
      }
    }
  }
  let repeatedTransitions = 0;
  for (const group of transitions.values()) {
    for (const word of group.slice(1)) add('SLP040', word.start, word.end);
    repeatedTransitions += Math.max(0, group.length - 1);
  }

  const lengths = sentences.map(sentence => sentence.words.length);
  const mean = lengths.length ? words.length / lengths.length : 0;
  const variance = lengths.length ? lengths.reduce((sum, length) => sum + (length - mean) ** 2, 0) / lengths.length : 0;
  const deviation = Math.sqrt(variance);
  const cv = mean ? deviation / mean : null;
  const rhythmAssessed = sentences.length >= 6 && words.length >= 60;
  const rhythmPenalty = rhythmAssessed && cv < 0.25 ? cap((1 - cv / 0.25) * 100) : 0;
  if (rhythmPenalty > 0) add('SLP050', sentences[0].start, sentences[2].words.at(-1).end);

  findings.sort((a, b) => a.start - b.start || a.end - b.end || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
  const counts = Object.fromEntries(RULES.map(rule => [rule.id, 0]));
  for (const finding of findings) counts[finding.ruleId]++;
  const denominator = Math.max(words.length, 100);
  const scores = {};
  for (const category of Object.keys(CATEGORIES)) {
    const active = RULES.filter(rule => rule.category === category && !ignored.has(rule.id));
    scores[category] = words.length && active.length
      ? cap(active.reduce((sum, rule) => sum + counts[rule.id] * rule.points, 0) * 100 / denominator)
      : null;
  }
  if (scores.adverbs !== null) scores.adverbs = cap(counts.SLP020 / denominator * 1000);
  if (scores.punctuation !== null) scores.punctuation = cap(counts.SLP030 / denominator * 2000);
  if (scores.passive !== null) scores.passive = cap((ignored.has('SLP060') ? 0 : passiveSentences.size) / Math.max(sentences.length, 5) * 200);
  if (scores.rhythm !== null) scores.rhythm = rhythmPenalty;
  if (scores.repetition !== null) scores.repetition = cap((counts.SLP040 + counts.SLP041) / Math.max(sentences.length, 6) * 100);
  const activeWeight = Object.entries(CATEGORIES).reduce((sum, [key, category]) => sum + (scores[key] === null ? 0 : category.weight), 0);
  const overall = activeWeight
    ? round(Object.entries(CATEGORIES).reduce((sum, [key, category]) => sum + (scores[key] ?? 0) * category.weight, 0) / activeWeight)
    : null;

  const warnings = [];
  if (!words.length) warnings.push({ code: 'no-prose', message: 'No prose words were found; this is not a passing style check.' });
  else if (words.length < 100) warnings.push({ code: 'short-sample', message: 'Fewer than 100 words: scores use a 100-word floor and are weak evidence.' });
  if (!rhythmAssessed) warnings.push({ code: 'rhythm-not-assessed', message: 'Rhythm needs at least 6 sentences and 60 words; its score is 0 until then.' });
  if (settings.ignore.length) warnings.push({ code: 'rules-ignored', message: `Ignored rules: ${settings.ignore.join(', ')}. Keep these settings fixed between revisions.` });
  if (overall === null && words.length) warnings.push({ code: 'no-active-rules', message: 'All rules are ignored; there is no style score.' });
  if (findings.length > settings.maxFindings) warnings.push({ code: 'findings-truncated', message: 'Findings are truncated; counts and scores include every match.' });
  const locate = locator(source);
  const detailed = findings.slice(0, settings.maxFindings).map(finding => {
    const rule = ruleById.get(finding.ruleId);
    return {
      ruleId: rule.id, category: rule.category, kind: rule.kind, message: rule.name,
      start: locate(finding.start), end: locate(finding.end),
      text: source.slice(finding.start, finding.end), suggestion: rule.suggestion,
    };
  });
  return {
    schemaVersion: 1,
    rulesetVersion: RULESET_VERSION,
    scoreMeaning: 'Style-pattern penalties from 0 to 100; lower means fewer measured patterns, not AI probability or writing quality.',
    input: { sha256: createHash('sha256').update(source, 'utf8').digest('hex'), bytes, format: settings.format },
    settings,
    metrics: {
      words: words.length, sentences: sentences.length,
      adverbCandidates: adverbWords.length, adverbDensityPercent: percent(adverbWords.length, words.length),
      emDashes: emDashes.length, emDashesPer1000Words: words.length ? round(emDashes.length / words.length * 1000) : 0,
      passiveCandidateSentences: passiveSentences.size, passiveSentencePercent: percent(passiveSentences.size, sentences.length),
      repeatedOpenings, repeatedTransitions,
      sentenceLength: { mean: round(mean), standardDeviation: round(deviation), coefficientOfVariation: cv === null ? null : round(cv), rhythmAssessed },
    },
    scores: { overall, categories: scores },
    rules: RULES.map(rule => ({ id: rule.id, category: rule.category, enabled: !ignored.has(rule.id), count: counts[rule.id] })),
    strongestIssues: Object.keys(CATEGORIES).filter(key => scores[key] > 0)
      .sort((a, b) => scores[b] - scores[a] || Object.keys(CATEGORIES).indexOf(a) - Object.keys(CATEGORIES).indexOf(b))
      .slice(0, 3).map(category => ({ category, score: scores[category], ruleIds: RULES.filter(rule => rule.category === category && counts[rule.id]).map(rule => rule.id) })),
    findingsTotal: findings.length,
    findings: detailed,
    warnings,
  };
}

export function compareTexts(beforeText, afterText, options = {}) {
  // Reanalyze original text so saved reports cannot mix versions or settings.
  const before = analyze(beforeText, options);
  const after = analyze(afterText, options);
  const delta = (a, b) => a === null || b === null ? null : round(b - a);
  const overallDelta = delta(before.scores.overall, after.scores.overall);
  return {
    before,
    after,
    comparison: {
      outcome: overallDelta === null ? 'not-comparable' : overallDelta < 0 ? 'decreased' : overallDelta > 0 ? 'increased' : 'unchanged',
      overallDelta,
      categoryDeltas: Object.fromEntries(Object.keys(CATEGORIES).map(key => [key, delta(before.scores.categories[key], after.scores.categories[key])])),
      ruleCountDeltas: Object.fromEntries(before.rules.map((rule, i) => [rule.id, after.rules[i].count - rule.count])),
      wordCountDelta: after.metrics.words - before.metrics.words,
      sentenceCountDelta: after.metrics.sentences - before.metrics.sentences,
      rhythmAssessmentChanged: before.metrics.sentenceLength.rhythmAssessed !== after.metrics.sentenceLength.rhythmAssessed,
      meaningPreserved: 'not-assessed',
    },
  };
}
