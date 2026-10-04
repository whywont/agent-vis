// Fable/Mythos and Opus/Sonnet 5+ think by default, and thinking tokens count
// against max_tokens. Some of them reject disabling thinking outright, so keep
// thinking on, ask for low effort, and leave room for the answer.
export const THINKING_HEADROOM_TOKENS = 4096;

export function thinksByDefault(model: string): boolean {
  if (/^claude-(fable|mythos)-/.test(model)) return true;
  const major = /^claude-[a-z]+-(\d+)(?:-|$)/.exec(model)?.[1];
  return major !== undefined && Number(major) >= 5;
}

export function explainRequestParams(model: string, answerTokens: number) {
  return thinksByDefault(model)
    ? { max_tokens: answerTokens + THINKING_HEADROOM_TOKENS, output_config: { effort: "low" as const } }
    : { max_tokens: answerTokens };
}
