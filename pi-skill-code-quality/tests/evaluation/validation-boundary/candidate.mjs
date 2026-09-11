import path from "node:path";

export function resolveDestination(root, value) {
  if (typeof root !== "string" || typeof value !== "string" || !value) throw new TypeError("destination is invalid");
  const resolvedRoot = path.resolve(root);
  const destination = path.resolve(resolvedRoot, value);
  const relative = path.relative(resolvedRoot, destination);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError("destination escapes the root");
  }
  return destination;
}
