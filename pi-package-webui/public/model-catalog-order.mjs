const alphabetical = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const releaseDatePattern = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2})))?$/;

function calendarDate(value) {
  if (typeof value !== "string") return null;
  const match = releaseDatePattern.exec(value);
  if (!match || match[0] !== value) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]) return null;

  if (match[4] !== undefined) {
    if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return null;
    if (match[7] !== "Z" && (Number(match[8]) > 23 || Number(match[9]) > 59)) return null;
  }
  return value.slice(0, 10);
}

/** Return an explicit release day, retaining a timestamp's stated calendar date. */
export function modelReleaseDate(model) {
  return calendarDate(model?.releaseDate) ?? calendarDate(model?.release_date);
}

function compareExact(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function displayName(model) {
  return typeof model.name === "string" && model.name.trim() ? model.name.trim() : model.id;
}

function compareModels(left, right) {
  const leftDate = modelReleaseDate(left);
  const rightDate = modelReleaseDate(right);
  if (leftDate !== rightDate) {
    if (leftDate === null) return 1;
    if (rightDate === null) return -1;
    return compareExact(rightDate, leftDate);
  }
  const leftName = displayName(left);
  const rightName = displayName(right);
  return alphabetical.compare(leftName, rightName)
    || alphabetical.compare(left.id, right.id)
    || compareExact(leftName, rightName)
    || compareExact(left.id, right.id);
}

/** Group API models without changing the input array, objects, or exact identities. */
export function groupModelCatalog(models) {
  const groups = new Map();
  for (const model of models) {
    if (!groups.has(model.provider)) groups.set(model.provider, []);
    groups.get(model.provider).push(model);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => alphabetical.compare(left, right) || compareExact(left, right))
    .map(([provider, providerModels]) => ({ provider, models: providerModels.sort(compareModels) }));
}
