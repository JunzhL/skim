import { describe, expect, it, vi } from "vitest";
import type { SkillRecord } from "@/lib/contracts";
import {
  analyzeConflict,
  createConfiguredConflictAdapter,
  createDeepSeekConflictAdapter,
  createMockConflictAdapter,
  createOpenAIConflictAdapter,
  type ConflictContentSource,
} from "@/lib/conflicts";
import { isSkimError } from "@/lib/errors";
import type { RuntimeConfig } from "@/lib/runtime-config";
import type { ConflictAnalysisRequest } from "@/lib/validation";

const hash = "a".repeat(64);

function skill(id: string, text: string): { record: SkillRecord; text: string } {
  return {
    record: {
      id,
      name: id,
      description: id,
      path: `skills/${id}`,
      source: { type: "builtin", name: id },
      files: [{ path: "SKILL.md", hash }],
      scopes: { tasks: ["dependency-management"], fileGlobs: ["package.json"] },
      enabled: true,
    },
    text,
  };
}

const pnpm = skill(
  "package-manager-policy",
  "# Package Manager Policy\n\nUse `pnpm add` and keep `pnpm-lock.yaml` updated.\n",
);
const npm = skill(
  "npm-workflow",
  "# NPM Workflow\n\nUse `npm install` and update `package-lock.json`.\n",
);

const request: ConflictAnalysisRequest = {
  candidate: {
    skillAId: "npm-workflow",
    skillBId: "package-manager-policy",
    reason: "task-and-file-scope",
    sharedTasks: ["dependency-management"],
    sharedFileGlobs: [{ a: "package.json", b: "package.json" }],
  },
  skillA: npm.record,
  skillB: pnpm.record,
};

const source: ConflictContentSource = {
  read(record, filePath) {
    if (filePath !== "SKILL.md") throw new Error("unexpected path");
    if (record.id === npm.record.id) return Buffer.from(npm.text);
    if (record.id === pnpm.record.id) return Buffer.from(pnpm.text);
    throw new Error("unexpected skill");
  },
};

const rawConflict = {
  commonScenario: "Adding a JavaScript dependency",
  confidence: 0.98,
  explanation: "The skills require different package managers and lockfiles for the same task.",
  evidence: [
    {
      skillId: "npm-workflow",
      filePath: "SKILL.md",
      lineStart: 3,
      lineEnd: 3,
      quote: "Use `npm install`",
    },
    {
      skillId: "package-manager-policy",
      filePath: "SKILL.md",
      lineStart: 3,
      lineEnd: 3,
      quote: "Use `pnpm add`",
    },
  ],
};

function baseConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    repoPath: "/tmp/managed",
    conflictModelProvider: "openai",
    openaiApiKey: "openai-key",
    openaiModel: "gpt-5.6-terra",
    deepseekApiKey: "deepseek-key",
    deepseekModel: "deepseek-flash",
    ...overrides,
  };
}

describe("provider-neutral conflict analysis", () => {
  it.each([
    ["openai" as const, "gpt-5.6-terra"],
    ["deepseek" as const, "deepseek-flash"],
  ])("normalizes %s output into the same verified report", async (provider, model) => {
    const report = await analyzeConflict(request, {
      source,
      adapter: createMockConflictAdapter(provider, model, rawConflict),
    });
    expect(report).toMatchObject({
      skillAId: "npm-workflow",
      skillBId: "package-manager-policy",
      analysis: { provider, model },
      commonScenario: rawConflict.commonScenario,
    });
    expect(report.evidence).toHaveLength(2);
  });

  it.each([
    ["fabricated quote", { ...rawConflict, evidence: [{ ...rawConflict.evidence[0], quote: "not in source" }, rawConflict.evidence[1]] }],
    ["line outside file", { ...rawConflict, evidence: [{ ...rawConflict.evidence[0], lineStart: 99, lineEnd: 99 }, rawConflict.evidence[1]] }],
    ["outside candidate", { ...rawConflict, evidence: [{ ...rawConflict.evidence[0], skillId: "third-skill" }, rawConflict.evidence[1]] }],
    ["unknown file", { ...rawConflict, evidence: [{ ...rawConflict.evidence[0], filePath: "OTHER.md" }, rawConflict.evidence[1]] }],
  ])("rejects invalid citation: %s", async (_name, result) => {
    await expect(
      analyzeConflict(request, {
        source,
        adapter: createMockConflictAdapter("openai", "test", result),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFLICT_CITATION" });
  });

  it("rejects schema mismatch before citation verification", async () => {
    await expect(
      analyzeConflict(request, {
        source,
        adapter: createMockConflictAdapter("deepseek", "test", { ...rawConflict, confidence: 2 }),
      }),
    ).rejects.toMatchObject({ code: "MODEL_PROVIDER_SCHEMA_MISMATCH" });
  });

  it("selects exactly one configured provider even when both keys exist", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("openai.com")) {
        return new Response(
          JSON.stringify({
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(rawConflict) }] }],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(rawConflict) } }] }),
        { status: 200 },
      );
    });

    await createConfiguredConflictAdapter(baseConfig(), { fetchImpl }).analyze({ prompt: "JSON please" });
    expect(calls).toEqual(["https://api.openai.com/v1/responses"]);

    calls.length = 0;
    await createConfiguredConflictAdapter(
      baseConfig({ conflictModelProvider: "deepseek" }),
      { fetchImpl },
    ).analyze({ prompt: "JSON please" });
    expect(calls).toEqual(["https://api.deepseek.com/chat/completions"]);
  });

  it("does not silently fall back when the selected provider key is missing", () => {
    try {
      createConfiguredConflictAdapter(baseConfig({ openaiApiKey: undefined }));
      throw new Error("expected missing OpenAI credentials");
    } catch (error) {
      expect(isSkimError(error, "MODEL_PROVIDER_CREDENTIALS_MISSING")).toBe(true);
    }

    try {
      createConfiguredConflictAdapter(
        baseConfig({ conflictModelProvider: "deepseek", deepseekApiKey: undefined }),
      );
      throw new Error("expected missing DeepSeek credentials");
    } catch (error) {
      expect(isSkimError(error, "MODEL_PROVIDER_CREDENTIALS_MISSING")).toBe(true);
    }
  });
});

describe("provider response boundaries", () => {
  it("parses OpenAI Structured Output and catches refusals", async () => {
    const success = createOpenAIConflictAdapter("key", "model", {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(rawConflict) }] }],
          }),
          { status: 200 },
        ),
    });
    await expect(success.analyze({ prompt: "x" })).resolves.toEqual(rawConflict);

    const refusal = createOpenAIConflictAdapter("key", "model", {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
          }),
          { status: 200 },
        ),
    });
    await expect(refusal.analyze({ prompt: "x" })).rejects.toMatchObject({ code: "MODEL_PROVIDER_REFUSAL" });
  });

  it("rejects DeepSeek empty and malformed JSON content", async () => {
    const empty = createDeepSeekConflictAdapter("key", "model", {
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "" } }] }), { status: 200 }),
    });
    await expect(empty.analyze({ prompt: "x" })).rejects.toMatchObject({ code: "MODEL_PROVIDER_EMPTY_RESPONSE" });

    const malformed = createDeepSeekConflictAdapter("key", "model", {
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "{" } }] }), { status: 200 }),
    });
    await expect(malformed.analyze({ prompt: "x" })).rejects.toMatchObject({ code: "MODEL_PROVIDER_MALFORMED_RESPONSE" });
  });

  it.each([
    ["content_filter", "MODEL_PROVIDER_REFUSAL"],
    ["length", "MODEL_PROVIDER_TRANSPORT_ERROR"],
    ["tool_calls", "MODEL_PROVIDER_TRANSPORT_ERROR"],
    ["insufficient_system_resource", "MODEL_PROVIDER_TRANSPORT_ERROR"],
    ["aborted", "MODEL_PROVIDER_TRANSPORT_ERROR"],
  ])("rejects DeepSeek finish reason %s", async (finishReason, code) => {
    const adapter = createDeepSeekConflictAdapter("key", "model", {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(rawConflict) } }],
          }),
          { status: 200 },
        ),
    });

    await expect(adapter.analyze({ prompt: "x" })).rejects.toMatchObject({ code });
  });

  it("reports timeout and transport errors without converting them into fallback calls", async () => {
    const timeoutFetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const timeout = createOpenAIConflictAdapter("key", "model", { fetchImpl: timeoutFetch, timeoutMs: 1 });
    await expect(timeout.analyze({ prompt: "x" })).rejects.toMatchObject({ code: "MODEL_PROVIDER_TIMEOUT" });
    expect(timeoutFetch).toHaveBeenCalledTimes(1);

    const transport = createDeepSeekConflictAdapter("key", "model", {
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    try {
      await transport.analyze({ prompt: "x" });
      throw new Error("expected provider error");
    } catch (error) {
      expect(isSkimError(error, "MODEL_PROVIDER_TRANSPORT_ERROR")).toBe(true);
    }
  });
});
