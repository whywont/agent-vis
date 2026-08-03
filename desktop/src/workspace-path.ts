function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

export function workspaceRelativePath(filepath: string, workspaceRoot: string): string {
  const path = normalizeSeparators(filepath.trim());
  const root = normalizeSeparators(workspaceRoot.trim()).replace(/\/$/, "");

  if (!path || !root || !path.startsWith("/")) return path;
  if (path === root) return ".";
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}
