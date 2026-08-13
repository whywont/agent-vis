import { useState } from "react";
import {
  mcpElicitationContent,
  mcpElicitationDefaults,
  mcpFieldSatisfied,
  type InteractiveAgentRequest,
  type InteractiveAgentResponse,
  type InteractiveApprovalDecision,
  type InteractiveMcpElicitationField,
  type InteractiveMcpElicitationValue,
} from "./interactive-agent-requests";

export default function InteractiveAgentRequestPanel({
  request,
  responding,
  onRespond,
}: {
  request: InteractiveAgentRequest;
  responding: boolean;
  onRespond: (response: InteractiveAgentResponse) => void;
}) {
  if (request.type === "approval") {
    return (
      <aside className="desktop-codex-approval" aria-live="assertive">
        <span>Blocked - permission needed</span>
        <p>{request.reason}</p>
        {request.details && <code>{request.details}</code>}
        <div>
          {request.decisions.filter(isRenderableApprovalDecision).map((decision, index) => (
            <button
              key={approvalDecisionKey(decision)}
              type="button"
              disabled={responding}
              onClick={() => onRespond({ type: "approval", decision })}
            >
              {approvalDecisionLabel(decision, index)}
            </button>
          ))}
        </div>
      </aside>
    );
  }
  if (request.type === "user_input") {
    return <UserInputPanel request={request} responding={responding} onRespond={onRespond} />;
  }
  return <McpElicitationPanel request={request} responding={responding} onRespond={onRespond} />;
}

function UserInputPanel({ request, responding, onRespond }: {
  request: Extract<InteractiveAgentRequest, { type: "user_input" }>;
  responding: boolean;
  onRespond: (response: InteractiveAgentResponse) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, boolean>>({});
  const [multiSelections, setMultiSelections] = useState<Record<string, string[]>>({});
  const submittedAnswers = composeUserInputAnswers(request, answers, multiSelections);
  return (
    <aside className="desktop-codex-approval desktop-codex-user-input" aria-live="assertive">
      <span>Blocked - answer needed</span>
      <form onSubmit={(event) => { event.preventDefault(); onRespond({ type: "user_input", answers: submittedAnswers }); }}>
        {request.questions.map((question) => (
          <fieldset key={question.id}>
            <legend>{question.header}</legend>
            <p>{question.question}</p>
            {question.options.map((option) => question.multiSelect ? (
              <label key={option.label}>
                <input
                  type="checkbox"
                  name={`agent-question-${question.id}`}
                  value={option.label}
                  checked={multiSelections[question.id]?.includes(option.label) === true}
                  onChange={(event) => setMultiSelections((current) => {
                    const selected = current[question.id] || [];
                    return {
                      ...current,
                      [question.id]: event.target.checked
                        ? [...selected, option.label]
                        : selected.filter((label) => label !== option.label),
                    };
                  })}
                />
                <span><strong>{option.label}</strong><small>{option.description}</small></span>
              </label>
            ) : (
              <label key={option.label}>
                <input
                  type="radio"
                  name={`agent-question-${question.id}`}
                  value={option.label}
                  checked={!other[question.id] && answers[question.id] === option.label}
                  onChange={() => {
                    setAnswers((current) => ({ ...current, [question.id]: option.label }));
                    setOther((current) => ({ ...current, [question.id]: false }));
                  }}
                />
                <span><strong>{option.label}</strong><small>{option.description}</small></span>
              </label>
            ))}
            {question.options.length === 0 && (
              <input
                className="desktop-codex-user-input-text"
                type={question.isSecret ? "password" : "text"}
                autoComplete="off"
                value={answers[question.id] || ""}
                onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                aria-label={question.header}
              />
            )}
            {question.options.length > 0 && question.isOther && question.multiSelect && (
              <label>
                <span className="desktop-codex-user-input-other">
                  <strong>Other</strong>
                  <input
                    className="desktop-codex-user-input-text"
                    type={question.isSecret ? "password" : "text"}
                    autoComplete="off"
                    value={answers[question.id] || ""}
                    onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                    aria-label={`${question.header} other answer`}
                  />
                </span>
              </label>
            )}
            {question.options.length > 0 && question.isOther && !question.multiSelect && (
              <label>
                <input
                  type="radio"
                  name={`agent-question-${question.id}`}
                  checked={other[question.id] === true}
                  onChange={() => {
                    setAnswers((current) => ({ ...current, [question.id]: "" }));
                    setOther((current) => ({ ...current, [question.id]: true }));
                  }}
                />
                <span className="desktop-codex-user-input-other">
                  <strong>Other</strong>
                  <input
                    className="desktop-codex-user-input-text"
                    type={question.isSecret ? "password" : "text"}
                    autoComplete="off"
                    value={other[question.id] ? answers[question.id] || "" : ""}
                    onFocus={() => setOther((current) => ({ ...current, [question.id]: true }))}
                    onChange={(event) => {
                      setOther((current) => ({ ...current, [question.id]: true }));
                      setAnswers((current) => ({ ...current, [question.id]: event.target.value }));
                    }}
                    aria-label={`${question.header} other answer`}
                  />
                </span>
              </label>
            )}
          </fieldset>
        ))}
        {request.questions.length === 0 && <p>The agent sent an empty question set.</p>}
        <div className="desktop-codex-user-input-actions">
          <button
            type="submit"
            disabled={responding || request.questions.length === 0 || request.questions.some((question) => !submittedAnswers[question.id]?.trim())}
          >
            Submit answers
          </button>
          <button type="button" disabled={responding} onClick={() => onRespond({ type: "user_input", answers: {} })}>Skip</button>
        </div>
      </form>
    </aside>
  );
}

export function composeUserInputAnswers(
  request: Extract<InteractiveAgentRequest, { type: "user_input" }>,
  answers: Record<string, string>,
  multiSelections: Record<string, string[]>,
): Record<string, string> {
  return Object.fromEntries(request.questions.map((question) => {
    if (!question.multiSelect) return [question.id, answers[question.id] || ""];
    const values = [...(multiSelections[question.id] || [])];
    const custom = answers[question.id]?.trim();
    if (custom) values.push(custom);
    return [question.id, values.join(", ")];
  }));
}

function McpElicitationPanel({ request, responding, onRespond }: {
  request: Extract<InteractiveAgentRequest, { type: "mcp_elicitation" }>;
  responding: boolean;
  onRespond: (response: InteractiveAgentResponse) => void;
}) {
  const [values, setValues] = useState<Record<string, InteractiveMcpElicitationValue>>(() => mcpElicitationDefaults(request));
  const respond = (action: "accept" | "decline" | "cancel") => onRespond({
    type: "mcp_elicitation",
    action,
    content: mcpElicitationContent(request, values),
  });
  return (
    <aside className="desktop-codex-approval desktop-codex-user-input desktop-mcp-elicitation" aria-live="assertive">
      <span>Blocked - MCP input needed</span>
      <p><strong>{request.serverName}</strong> · {request.message}</p>
      {request.mode === "url" && request.url && (
        <a href={request.url} target="_blank" rel="noopener noreferrer">Open secure request</a>
      )}
      {request.unsupportedReason && <p className="desktop-mcp-elicitation-warning">{request.unsupportedReason}</p>}
      {request.mode === "form" && (
        <form onSubmit={(event) => { event.preventDefault(); respond("accept"); }}>
          {request.fields.map((field) => (
            <McpElicitationFieldControl
              key={field.id}
              field={field}
              value={values[field.id]}
              onChange={(value) => setValues((current) => ({ ...current, [field.id]: value }))}
            />
          ))}
          {request.fields.length === 0 && !request.unsupportedReason && <p>This request has no fields.</p>}
          <div className="desktop-codex-user-input-actions">
            <button
              type="submit"
              disabled={responding || !request.canAccept || request.fields.some((field) => !mcpFieldSatisfied(field, values[field.id]))}
            >
              Submit to server
            </button>
            <button type="button" disabled={responding} onClick={() => respond("decline")}>Decline</button>
            <button type="button" disabled={responding} onClick={() => respond("cancel")}>Cancel turn</button>
          </div>
        </form>
      )}
      {request.mode !== "form" && (
        <div>
          {request.canAccept && <button type="button" disabled={responding} onClick={() => respond("accept")}>I completed it</button>}
          <button type="button" disabled={responding} onClick={() => respond("decline")}>Decline</button>
          <button type="button" disabled={responding} onClick={() => respond("cancel")}>Cancel turn</button>
        </div>
      )}
    </aside>
  );
}

function McpElicitationFieldControl({ field, value, onChange }: {
  field: InteractiveMcpElicitationField;
  value: InteractiveMcpElicitationValue | undefined;
  onChange: (value: InteractiveMcpElicitationValue) => void;
}) {
  const help = field.description && <small>{field.description}</small>;
  if (field.kind === "boolean") {
    return (
      <fieldset>
        <legend>{field.title}{field.required ? " *" : ""}</legend>
        <label>
          <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
          <span><strong>{field.title}</strong>{help}</span>
        </label>
      </fieldset>
    );
  }
  if (field.kind === "single_select") {
    return (
      <fieldset>
        <legend>{field.title}{field.required ? " *" : ""}</legend>
        {help}
        <select className="desktop-codex-user-input-text" value={typeof value === "string" ? value : ""} required={field.required} onChange={(event) => onChange(event.target.value)}>
          <option value="">Select an option</option>
          {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </fieldset>
    );
  }
  if (field.kind === "multi_select") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset>
        <legend>{field.title}{field.required ? " *" : ""}</legend>
        {help}
        {field.options?.map((option) => (
          <label key={option.value}>
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={(event) => onChange(event.target.checked
                ? [...selected, option.value]
                : selected.filter((item) => item !== option.value))}
            />
            <span><strong>{option.label}</strong></span>
          </label>
        ))}
      </fieldset>
    );
  }
  if (field.kind === "number" || field.kind === "integer") {
    return (
      <fieldset>
        <legend>{field.title}{field.required ? " *" : ""}</legend>
        {help}
        <input
          className="desktop-codex-user-input-text"
          type="number"
          step={field.kind === "integer" ? 1 : "any"}
          min={field.minimum}
          max={field.maximum}
          required={field.required}
          value={typeof value === "number" ? value : ""}
          onChange={(event) => onChange(event.target.value === "" ? "" : event.target.valueAsNumber)}
        />
      </fieldset>
    );
  }
  return (
    <fieldset>
      <legend>{field.title}{field.required ? " *" : ""}</legend>
      {help}
      <input
        className="desktop-codex-user-input-text"
        type={mcpInputType(field.format)}
        minLength={field.minLength}
        maxLength={field.maxLength}
        required={field.required}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      />
    </fieldset>
  );
}

function mcpInputType(format: InteractiveMcpElicitationField["format"]): "text" | "email" | "url" | "date" | "datetime-local" {
  if (format === "email") return "email";
  if (format === "uri") return "url";
  if (format === "date") return "date";
  if (format === "date-time") return "datetime-local";
  return "text";
}

function isRenderableApprovalDecision(decision: InteractiveApprovalDecision): boolean {
  if (typeof decision === "string") return [
    "accept", "acceptForSession", "decline", "cancel",
    "approved", "approved_for_session", "denied", "abort",
  ].includes(decision);
  return "acceptWithExecpolicyAmendment" in decision
    || "applyNetworkPolicyAmendment" in decision
    || "approved_execpolicy_amendment" in decision
    || "network_policy_amendment" in decision;
}

function approvalDecisionKey(decision: InteractiveApprovalDecision): string {
  return typeof decision === "string" ? decision : JSON.stringify(decision);
}

function approvalDecisionLabel(decision: InteractiveApprovalDecision, index: number): string {
  if (decision === "accept" || decision === "approved") return "1. Approve";
  if (decision === "acceptForSession" || decision === "approved_for_session" || (typeof decision === "object" && (
    "acceptWithExecpolicyAmendment" in decision
    || "applyNetworkPolicyAmendment" in decision
    || "approved_execpolicy_amendment" in decision
    || "network_policy_amendment" in decision
  ))) return "2. Approve, don't ask again";
  if (decision === "decline" || decision === "denied") return "Decline";
  if (decision === "cancel" || decision === "abort") return "Cancel turn";
  return `${index + 1}. Approve`;
}
