const parse = value => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) throw new Error(`Unsupported dependency version: ${value}`);
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] };
};
const compare = (a, b) => {
  for (let index = 0; index < 3; index++) if (a.numbers[index] !== b.numbers[index]) return Math.sign(a.numbers[index] - b.numbers[index]);
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  throw new Error('Cannot compare two prerelease dependency versions');
};

// Release candidates are stable versions. Tags are resolved by registry, except
// latest, which is the default tag assigned by this engine's publish command.
export function satisfies(version, range, tag = 'latest') {
  const current = parse(version);
  if (range === tag) return true;
  return range.split('||').some(part => {
    const trimmed = part.trim();
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
    if (hyphen) return satisfies(version, `>=${hyphen[1]} <=${hyphen[2]}`, tag);
    const tokens = trimmed.replace(/([<>=~^]+)\s+/g, '$1').split(/\s+/).filter(Boolean);
    return tokens.every(token => {
      const match = /^(<=|>=|<|>|=|~|\^)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(token);
      if (!match) throw new Error(`Unsupported dependency range: ${range}`);
      const operator = match[1] ?? '=';
      const parts = match.slice(2, 5);
      const specified = parts.findIndex(item => item === undefined || /^[xX*]$/.test(item));
      const width = specified < 0 ? 3 : specified;
      const numbers = parts.map(item => item && /^\d+$/.test(item) ? Number(item) : 0);
      const lower = { numbers, prerelease: match[5]?.slice(1) };
      if (!width) return !['<', '>'].includes(operator);
      const difference = compare(current, lower);
      if (['>=','<'].includes(operator)) return operator === '>=' ? difference >= 0 : difference < 0;
      if (['>','<='].includes(operator) && width === 3) return operator === '>' ? difference > 0 : difference <= 0;
      const upper = [...numbers];
      let increment = width - 1;
      if (operator === '~') increment = width === 1 ? 0 : 1;
      if (operator === '^') increment = numbers[0] ? 0 : width === 1 ? 0 : numbers[1] ? 1 : width === 2 ? 1 : 2;
      upper[increment]++;
      for (let index = increment + 1; index < 3; index++) upper[index] = 0;
      if (operator === '>') return compare(current, { numbers: upper }) >= 0;
      if (operator === '<=') return compare(current, { numbers: upper }) < 0;
      if (width === 3 && operator === '=') return difference === 0;
      return difference >= 0 && compare(current, { numbers: upper }) < 0;
    });
  });
}
