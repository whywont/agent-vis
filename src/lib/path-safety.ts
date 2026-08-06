import fs from "fs";
import path from "path";

/**
 * Returns true only when `target`, after normalization, resolves to `dir`
 * itself or a path nested inside it. Unlike a raw `startsWith` check this is
 * not fooled by `..` segments (e.g. "$HOME/../../etc/passwd"), which is the
 * classic directory-traversal bypass.
 */
export function isInsideDir(target: string, dir: string): boolean {
  const resolvedTarget = path.resolve(target);
  const resolvedDir = path.resolve(dir);
  if (resolvedTarget === resolvedDir) return true;
  const rel = path.relative(resolvedDir, resolvedTarget);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve an existing path through every symlink and return it only when the
 * final filesystem object is still contained by an allowed root.
 */
export function resolveExistingPathInsideDirs(
  target: string,
  dirs: string[],
): string | null {
  try {
    const resolvedTarget = fs.realpathSync.native(target);
    return dirs.some((dir) => {
      const resolvedDir = fs.realpathSync.native(dir);
      return isInsideDir(resolvedTarget, resolvedDir);
    })
      ? resolvedTarget
      : null;
  } catch {
    return null;
  }
}
