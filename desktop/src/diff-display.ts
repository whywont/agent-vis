export const OVERSIZED_DIFF_CONTEXT_LENGTH = 500;

export function shouldCompactDiffContextLine(type: string, text: string): boolean {
  return type === "context" && text.length > OVERSIZED_DIFF_CONTEXT_LENGTH;
}
