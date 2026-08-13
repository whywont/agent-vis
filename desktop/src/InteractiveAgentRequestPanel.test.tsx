import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import InteractiveAgentRequestPanel, { composeUserInputAnswers } from "./InteractiveAgentRequestPanel";
import type { InteractiveUserInputRequest } from "./interactive-agent-requests";

const userInputRequest: InteractiveUserInputRequest = {
  type: "user_input",
  requestId: "question-1",
  method: "canUseTool/AskUserQuestion",
  questions: [{
    id: "Which packages?",
    header: "Scope",
    question: "Which packages?",
    options: [
      { label: "Desktop", description: "Tauri desktop" },
      { label: "Web", description: "Browser client" },
    ],
    isOther: true,
    isSecret: false,
    multiSelect: true,
  }],
};

describe("shared interactive request panel", () => {
  it("renders provider-neutral multi-select user input controls", () => {
    const html = renderToStaticMarkup(
      <InteractiveAgentRequestPanel
        request={userInputRequest}
        responding={false}
        onRespond={() => {}}
      />,
    );
    expect(html).toContain("Blocked - answer needed");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Desktop");
    expect(html).toContain("Other");
    expect(html).toContain("Submit answers");
  });

  it("combines selected and custom multi-select answers for provider adapters", () => {
    expect(composeUserInputAnswers(
      userInputRequest,
      { "Which packages?": "API" },
      { "Which packages?": ["Desktop", "Web"] },
    )).toEqual({ "Which packages?": "Desktop, Web, API" });
  });

  it("renders MCP forms through the same shared panel", () => {
    const html = renderToStaticMarkup(
      <InteractiveAgentRequestPanel
        responding={false}
        onRespond={() => {}}
        request={{
          type: "mcp_elicitation",
          requestId: "mcp-1",
          method: "mcpServer/elicitation/request",
          mode: "form",
          serverName: "deploy-tools",
          message: "Choose a target",
          canAccept: true,
          fields: [{
            id: "environment",
            title: "Environment",
            description: "Deployment environment",
            required: true,
            kind: "single_select",
            options: [{ value: "staging", label: "Staging" }],
          }],
        }}
      />,
    );
    expect(html).toContain("Blocked - MCP input needed");
    expect(html).toContain("deploy-tools");
    expect(html).toContain("Submit to server");
  });

  it("renders compatible OpenAI extended forms through the safe form controls", () => {
    const html = renderToStaticMarkup(
      <InteractiveAgentRequestPanel
        responding={false}
        onRespond={() => {}}
        request={{
          type: "mcp_elicitation",
          requestId: "mcp-openai-1",
          method: "mcpServer/elicitation/request",
          mode: "openai/form",
          serverName: "deploy-tools",
          message: "Choose a region",
          canAccept: true,
          fields: [{
            id: "region",
            title: "Region",
            description: "Deployment region",
            required: true,
            kind: "single_select",
            options: [{ value: "us-east-1", label: "US East" }],
          }],
        }}
      />,
    );
    expect(html).toContain("Choose a region");
    expect(html).toContain("Submit to server");
    expect(html).not.toContain("I completed it");
  });

  it("renders URL elicitations as an explicit system-browser action", () => {
    const html = renderToStaticMarkup(
      <InteractiveAgentRequestPanel
        responding={false}
        onRespond={() => {}}
        request={{
          type: "mcp_elicitation",
          requestId: "mcp-url-1",
          method: "mcpServer/elicitation/request",
          mode: "url",
          serverName: "identity-provider",
          message: "Complete sign-in",
          url: "https://example.com/authorize",
          canAccept: true,
          fields: [],
        }}
      />,
    );
    expect(html).toContain("Open secure request");
    expect(html).toContain("I completed it");
    expect(html).not.toContain('target="_blank"');
  });
});
