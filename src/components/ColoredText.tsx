import type { ReactNode } from "react";

type Tone = "shell" | "output" | "code";

type Style = {
  fg?: string;
  bold?: boolean;
  dim?: boolean;
};

const ANSI_COLORS: Record<number, string> = {
  30: "ansi-black",
  31: "ansi-red",
  32: "ansi-green",
  33: "ansi-yellow",
  34: "ansi-blue",
  35: "ansi-magenta",
  36: "ansi-cyan",
  37: "ansi-white",
  90: "ansi-bright-black",
  91: "ansi-bright-red",
  92: "ansi-bright-green",
  93: "ansi-bright-yellow",
  94: "ansi-bright-blue",
  95: "ansi-bright-magenta",
  96: "ansi-bright-cyan",
  97: "ansi-bright-white",
};

function classNameFor(style: Style) {
  return [style.fg, style.bold && "ansi-bold", style.dim && "ansi-dim"]
    .filter(Boolean)
    .join(" ");
}

function applySgr(style: Style, codes: number[]): Style {
  const next = { ...style };
  for (const code of codes) {
    if (code === 0) {
      delete next.fg;
      delete next.bold;
      delete next.dim;
    } else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (ANSI_COLORS[code]) next.fg = ANSI_COLORS[code];
    else if (code === 39) delete next.fg;
  }
  return next;
}

function highlightShell(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\$\{[^}]+\}|\$[A-Za-z_][\w]*|--?[\w-]+|(?:~\/|\/|\.\/)[\w./@:-]*|\b(?:cd|git|pnpm|npm|npx|node|bun|deno|python3?|rg|find|sed|awk|curl|docker|make|adb|expo|gradle|java|cargo)\b|\b(?:true|false|null)\b|[|&;]|(?:"[^"]*"|'[^']*'))/g);
  return parts.map((part, index) => {
    let cls = "";
    if (/^\$/.test(part)) cls = "token-variable";
    else if (/^--?/.test(part)) cls = "token-flag";
    else if (/^(?:~\/|\/|\.\/)/.test(part)) cls = "token-path";
    else if (/^(?:cd|git|pnpm|npm|npx|node|bun|deno|python3?|rg|find|sed|awk|curl|docker|make|adb|expo|gradle|java|cargo)$/.test(part)) cls = "token-command";
    else if (/^(?:true|false|null)$/.test(part)) cls = "token-literal";
    else if (/^[|&;]$/.test(part)) cls = "token-operator";
    else if (/^(?:"|')/.test(part)) cls = "token-string";
    return cls ? <span className={cls} key={`${keyPrefix}-${index}`}>{part}</span> : part;
  });
}

function highlightCode(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\/\*.*?\*\/|\/\*.*|\*\/|\/\/.*|#.*|\.[\w-]+(?=\s*\{)|(?:"[^"]*"|'[^']*'|`[^`]*`)|\b(?:const|let|var|function|return|if|else|for|while|import|from|export|async|await|type|interface|class|new|extends|implements|throw|try|catch|finally|def|in)\b|\b(?:string|number|boolean|unknown|void|never|any|null|undefined|true|false)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*(?=\()|\b[A-Za-z_$][\w$]*(?=\s*:))/g);
  return parts.map((part, index) => {
    let cls = "";
    if (/^(?:\/\*|\*\/|\/\/|#)/.test(part)) cls = "code-comment";
    else if (/^\./.test(part)) cls = "code-selector";
    else if (/^(?:"|')|^`/.test(part)) cls = "code-string";
    else if (/^\d/.test(part)) cls = "code-number";
    else if (/^(?:string|number|boolean|unknown|void|never|any|null|undefined|true|false)$/.test(part)) cls = "code-type";
    else if (/^(?:const|let|var|function|return|if|else|for|while|import|from|export|async|await|type|interface|class|new|extends|implements|throw|try|catch|finally|def|in)$/.test(part)) cls = "code-keyword";
    else if (/^[A-Za-z_$][\w$]*$/.test(part)) cls = "code-function";
    return cls ? <span className={cls} key={`${keyPrefix}-${index}`}>{part}</span> : part;
  });
}

/** Renders terminal ANSI colors while keeping session text selectable and safe. */
export default function ColoredText({ text, tone = "output" }: { text: string; tone?: Tone }) {
  const chunks: Array<{ text: string; style: Style }> = [];
  const ansi = /\x1b\[([0-9;]*)m/g;
  let style: Style = {};
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = ansi.exec(text))) {
    if (match.index > cursor) chunks.push({ text: text.slice(cursor, match.index), style });
    style = applySgr(style, match[1] ? match[1].split(";").map(Number) : [0]);
    cursor = ansi.lastIndex;
  }
  if (cursor < text.length || chunks.length === 0) chunks.push({ text: text.slice(cursor), style });

  return (
    <>
      {chunks.map((chunk, index) => {
        const className = classNameFor(chunk.style);
        const content = tone === "shell"
          ? highlightShell(chunk.text, `shell-${index}`)
          : tone === "code"
            ? highlightCode(chunk.text, `code-${index}`)
            : chunk.text;
        return className ? <span className={className} key={index}>{content}</span> : <span key={index}>{content}</span>;
      })}
    </>
  );
}
