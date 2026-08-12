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

export function compactWorkspacePath(filepath: string, workspaceRoot: string): string {
  const relative = workspaceRelativePath(filepath, workspaceRoot);
  const parts = relative.split("/").filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join("/") : relative;
}
