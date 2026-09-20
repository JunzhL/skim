const originalFetch = globalThis.fetch;

const conflict = {
  commonScenario: "Adding a JavaScript dependency",
  confidence: 0.99,
  explanation: "The incoming skill requires npm while the active policy requires pnpm.",
  evidence: [
    {
      skillId: "npm-workflow",
      filePath: "SKILL.md",
      lineStart: 16,
      lineEnd: 16,
      quote: "When adding a JavaScript dependency, use `npm install` and update `package-lock.json`.",
    },
    {
      skillId: "package-manager-policy",
      filePath: "SKILL.md",
      lineStart: 16,
      lineEnd: 16,
      quote: "When adding a JavaScript dependency, use `pnpm add` and keep `pnpm-lock.yaml` updated.",
    },
  ],
};

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  if (url === "https://api.openai.com/v1/responses") {
    return Response.json({
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(conflict) }],
      }],
    });
  }

  if (url === "https://api.deepseek.com/chat/completions") {
    return Response.json({
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify(conflict) },
      }],
    });
  }

  return originalFetch(input, init);
};
