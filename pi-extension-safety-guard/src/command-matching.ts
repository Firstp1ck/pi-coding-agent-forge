type Token = { value: string; start: number; end: number };
const GLOBAL_OPTIONS = {
  git: {
    values: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]),
    flags: new Set(["--no-pager", "--paginate", "--bare", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-lazy-fetch"]),
  },
  docker: {
    values: new Set(["--context", "-c", "--host", "-H", "--config", "--log-level", "-l", "--tlscacert", "--tlscert", "--tlskey"]),
    flags: new Set(["--debug", "-D", "--tls", "--tlsverify"]),
  },
};

function tokensFor(text: string, argv?: readonly string[]): Token[] {
  if (argv) {
    let start = 0;
    return argv.map((value) => {
      const token = { value, start, end: start + value.length };
      start = token.end + 1;
      return token;
    });
  }
  // This is a conservative detection view, not a shell parser or execution argv.
  return [...text.matchAll(/(?:'[^'\r\n]*'|"[^"\r\n]*"|[^\s'";&|])+/g)]
    .map((match) => ({ value: match[0].replace(/['"]/g, ""), start: match.index, end: match.index + match[0].length }));
}

/** Return same-length detection views. Never replace input or approval identities. */
export function commandMatchTexts(text: string, argv?: readonly string[]): string[] {
  const unquoted = text.replace(/['"]/g, " ");
  const tokens = tokensFor(text, argv);
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const program = tokens[i].value.replace(/^.*[/\\]/, "");
    const options = program === "git" ? GLOBAL_OPTIONS.git : program === "docker" ? GLOBAL_OPTIONS.docker : undefined;
    if (!options) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      if (!/^[ \t]+$/.test(text.slice(tokens[j - 1].end, tokens[j].start))) break;
      const token = tokens[j];
      const equal = token.value.indexOf("=");
      const key = equal < 0 ? token.value : token.value.slice(0, equal);
      let end = token.end;
      if (options.values.has(key)) {
        if (equal < 0) {
          const value = tokens[j + 1];
          if (!value || !/^[ \t]+$/.test(text.slice(token.end, value.start))) break;
          end = value.end;
          j++;
        }
      } else if (!options.flags.has(key) && ![...options.values].some((option) => option.length === 2 && token.value.startsWith(option) && token.value.length > 2)) break;
      spans.push({ start: token.start, end });
      i = j;
    }
  }
  const masked = unquoted.split("");
  for (const { start, end } of spans) for (let index = start; index < end; index++) {
    if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
  }
  // Keep the original views: values such as git -c aliases may themselves execute code.
  return [...new Set([text, unquoted, masked.join("")])];
}
