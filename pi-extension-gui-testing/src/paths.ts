/**
 * Path containment shared by the file-set builder and export. Compares path
 * components, so a child named `..kept` is inside its parent while `..` and
 * `../x` are not.
 */
import { isAbsolute, relative, sep } from "node:path";

/** `relative()` result `rel` stays inside its base (or is the base itself). */
export function isRelativeInside(rel: string): boolean {
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** `child` equals `parent` or lies below it. Both paths must already be resolved. */
export function isWithin(child: string, parent: string): boolean {
  return isRelativeInside(relative(parent, child));
}
