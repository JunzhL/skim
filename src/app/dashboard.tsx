"use client";

import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentRun,
  BrowseCatalogResponse,
  BrowsedSkill,
  CatalogEntry,
  InstallPreview,
  PreviewResolution,
  SkillRecord,
  TransactionRecord,
  UndoConflict,
} from "@/lib/contracts";

type RegistryResponse = {
  configurationCommit: string;
  skills: SkillRecord[];
  agents: { id: string; name: string }[];
};

type AgentStatus = {
  agentId: string;
  name: string;
  loadedConfigurationCommit: string | null;
  activeSkillIds: string[];
};

type DashboardErrorState = {
  code: string;
  message: string;
};

class DashboardApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DashboardApiError";
    this.code = code;
  }
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(input, { ...init, headers });
  const body = await response.json().catch(() => null) as
    | { code?: string; message?: string }
    | T
    | null;

  if (!response.ok) {
    const failure = (body ?? {}) as { code?: string; message?: string };
    throw new DashboardApiError(
      failure.code ?? `HTTP_${response.status}`,
      failure.message ?? `Request failed with status ${response.status}`,
    );
  }
  return body as T;
}

function shortCommit(commit: string | null | undefined): string {
  if (!commit) return "not loaded";
  return commit.slice(0, 8);
}

function providerLabel(provider: string): string {
  return provider === "deepseek" ? "DeepSeek" : "OpenAI";
}

function errorPresentation(error: DashboardErrorState) {
  if (error.code === "DASHBOARD_REFRESH_FAILED") {
    return { title: "Refresh failed", tone: "border-amber-300 bg-amber-50 text-amber-950" };
  }
  if (error.code === "PREVIEW_STALE") {
    return { title: "Stale preview", tone: "border-amber-300 bg-amber-50 text-amber-950" };
  }
  if (error.code === "MODEL_PROVIDER_CREDENTIALS_MISSING") {
    return { title: "Provider credentials", tone: "border-rose-300 bg-rose-50 text-rose-950" };
  }
  if (error.code.startsWith("MODEL_PROVIDER_") || error.code === "INVALID_CONFLICT_CITATION") {
    return { title: "Provider analysis", tone: "border-rose-300 bg-rose-50 text-rose-950" };
  }
  return { title: "Transaction error", tone: "border-rose-300 bg-rose-50 text-rose-950" };
}

type StoreTab = "featured" | "browse" | "manual";

const STORE_TABS: { id: StoreTab; label: string }[] = [
  { id: "featured", label: "Featured" },
  { id: "browse", label: "Browse a repository" },
  { id: "manual", label: "Manual" },
];

function SectionHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-500">{eyebrow}</p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight text-neutral-950">{title}</h2>
      </div>
      {detail ? <p className="max-w-sm text-right text-xs leading-5 text-neutral-500">{detail}</p> : null}
    </div>
  );
}

function StatusPill({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
        active
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-neutral-200 bg-neutral-100 text-neutral-600",
      ].join(" ")}
    >
      {children}
    </span>
  );
}

export function Dashboard() {
  const [registry, setRegistry] = useState<RegistryResponse | null>(null);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentStatus | null>>({
    builder: null,
    reviewer: null,
  });
  const [agentRuns, setAgentRuns] = useState<Record<string, AgentRun | null>>({
    builder: null,
    reviewer: null,
  });

  const [initialLoading, setInitialLoading] = useState(true);
  const [previewPending, setPreviewPending] = useState(false);
  const [installPending, setInstallPending] = useState(false);
  const [agentPending, setAgentPending] = useState<Record<string, string | null>>({});
  const [undoPending, setUndoPending] = useState<string | null>(null);

  const [gitUrl, setGitUrl] = useState("");
  const [commit, setCommit] = useState("");
  const [subdirectory, setSubdirectory] = useState("");

  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [storeTab, setStoreTab] = useState<StoreTab>("featured");
  const [browseUrl, setBrowseUrl] = useState("https://github.com/anthropics/skills.git");
  const [browseCommit, setBrowseCommit] = useState("34040c9c568585f6929bedeaad110ad08f079624");
  const [browsedSkills, setBrowsedSkills] = useState<BrowsedSkill[] | null>(null);
  const [browsePending, setBrowsePending] = useState(false);
  const [task, setTask] = useState("add zod");

  const [preview, setPreview] = useState<InstallPreview | null>(null);
  const [resolution, setResolution] = useState<PreviewResolution | null>(null);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [undoConflict, setUndoConflict] = useState<UndoConflict | null>(null);
  const [error, setError] = useState<DashboardErrorState | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const refreshRepository = useCallback(async () => {
    const [registryResult, transactionResult] = await Promise.all([
      requestJson<RegistryResponse>("/api/registry"),
      requestJson<{ transactions: TransactionRecord[] }>("/api/transactions"),
    ]);
    setRegistry(registryResult);
    setTransactions(transactionResult.transactions);
  }, []);

  const refreshAgent = useCallback(async (agentId: string) => {
    const status = await requestJson<AgentStatus>(`/api/agents/${agentId}`);
    setAgentStatuses((current) => ({ ...current, [agentId]: status }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await Promise.all([
          refreshRepository(),
          refreshAgent("builder"),
          refreshAgent("reviewer"),
          requestJson<{ entries: CatalogEntry[] }>("/api/catalog")
            .then((response) => setCatalog(response.entries))
            .catch(() => setCatalog([])),
        ]);
      } catch (caught) {
        if (!cancelled) {
          const failure = caught instanceof DashboardApiError
            ? caught
            : new DashboardApiError("DASHBOARD_LOAD_FAILED", caught instanceof Error ? caught.message : String(caught));
          setError({ code: failure.code, message: failure.message });
        }
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshAgent, refreshRepository]);

  const installedSkillIds = useMemo(
    () => new Set((registry?.skills ?? []).map((skill) => skill.id)),
    [registry],
  );

  const undoneInstallIds = useMemo(
    () => new Set(
      transactions
        .filter((transaction): transaction is Extract<TransactionRecord, { type: "undo" }> => transaction.type === "undo")
        .map((transaction) => transaction.originalTransactionId),
    ),
    [transactions],
  );

  function presentError(caught: unknown) {
    const failure = caught instanceof DashboardApiError
      ? caught
      : new DashboardApiError("DASHBOARD_ACTION_FAILED", caught instanceof Error ? caught.message : String(caught));
    setSuccess(null);
    setError({ code: failure.code, message: failure.message });
  }

  async function refreshAfterCommit(committedMessage: string) {
    try {
      await refreshRepository();
    } catch (caught) {
      const failure = caught instanceof DashboardApiError
        ? caught
        : new DashboardApiError("DASHBOARD_REFRESH_FAILED", caught instanceof Error ? caught.message : String(caught));
      setError({
        code: "DASHBOARD_REFRESH_FAILED",
        message: `${committedMessage} Refresh the page to load the current repository state. Refresh error: ${failure.message}`,
      });
    }
  }

  async function previewSource(source: { url: string; commit: string; subdirectory: string }) {
    setPreviewPending(true);
    setError(null);
    setSuccess(null);
    setUndoConflict(null);
    setPreview(null);
    setResolution(null);
    setConfirmationOpen(false);

    try {
      const next = await requestJson<InstallPreview>("/api/imports/preview", {
        method: "POST",
        body: JSON.stringify({
          source: {
            type: "git",
            url: source.url.trim(),
            commit: source.commit.trim().toLowerCase(),
            subdirectory: source.subdirectory.trim(),
          },
        }),
      });
      setPreview(next);
    } catch (caught) {
      presentError(caught);
    } finally {
      setPreviewPending(false);
    }
  }

  async function createPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await previewSource({ url: gitUrl, commit, subdirectory });
  }

  async function browseRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBrowsePending(true);
    setError(null);
    setBrowsedSkills(null);

    try {
      const response = await requestJson<BrowseCatalogResponse>("/api/catalog/browse", {
        method: "POST",
        body: JSON.stringify({ url: browseUrl.trim(), commit: browseCommit.trim().toLowerCase() }),
      });
      setBrowsedSkills(response.skills);
    } catch (caught) {
      presentError(caught);
    } finally {
      setBrowsePending(false);
    }
  }

  async function confirmResolution() {
    if (!preview || !resolution) return;
    setInstallPending(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await requestJson<
        | { type: "cancelled"; previewId: string; transactionId: string }
        | Extract<TransactionRecord, { type: "install" }>
      >("/api/transactions/install", {
        method: "POST",
        body: JSON.stringify({ previewId: preview.previewId, resolution }),
      });

      if ("type" in result && result.type === "cancelled") {
        setSuccess("Preview cancelled. No repository commit was created.");
      } else {
        const committedMessage = `Installation committed at ${shortCommit(result.afterCommit)}.`;
        setSuccess(`${committedMessage} Reload agents to pick up the new configuration.`);
        setTransactions((current) => [result, ...current]);
        setPreview(null);
        setResolution(null);
        setConfirmationOpen(false);
        await refreshAfterCommit(committedMessage);
      }
      if (result.type === "cancelled") {
        setPreview(null);
        setResolution(null);
        setConfirmationOpen(false);
      }
    } catch (caught) {
      presentError(caught);
    } finally {
      setInstallPending(false);
    }
  }

  async function reloadAgent(agentId: string) {
    setAgentPending((current) => ({ ...current, [agentId]: "reload" }));
    setError(null);
    try {
      await requestJson(`/api/agents/${agentId}/reload`, { method: "POST" });
      await refreshAgent(agentId);
    } catch (caught) {
      presentError(caught);
    } finally {
      setAgentPending((current) => ({ ...current, [agentId]: null }));
    }
  }

  async function runAgent(agentId: string) {
    setAgentPending((current) => ({ ...current, [agentId]: "run" }));
    setError(null);
    try {
      const run = await requestJson<AgentRun>(`/api/agents/${agentId}/run`, {
        method: "POST",
        body: JSON.stringify({ task }),
      });
      setAgentRuns((current) => ({ ...current, [agentId]: run }));
    } catch (caught) {
      presentError(caught);
    } finally {
      setAgentPending((current) => ({ ...current, [agentId]: null }));
    }
  }

  async function undoTransaction(transactionId: string) {
    setUndoPending(transactionId);
    setError(null);
    setSuccess(null);
    setUndoConflict(null);
    try {
      const result = await requestJson<
        | { type: "committed"; transaction: Extract<TransactionRecord, { type: "undo" }> }
        | UndoConflict
      >(`/api/transactions/${transactionId}/undo`, { method: "POST" });

      if (result.type === "conflict") {
        setUndoConflict(result);
      } else {
        const committedMessage = `Undo committed at ${shortCommit(result.transaction.afterCommit)}.`;
        setSuccess(`${committedMessage} Reload agents to observe the restored configuration.`);
        setTransactions((current) => [result.transaction, ...current]);
        await refreshAfterCommit(committedMessage);
      }
    } catch (caught) {
      presentError(caught);
    } finally {
      setUndoPending(null);
    }
  }

  const selectedDiff = preview && resolution && resolution !== "cancel"
    ? preview.resolutionDiffs[resolution]
    : null;

  const errorView = error ? errorPresentation(error) : null;

  return (
    <main className="mx-auto min-h-screen max-w-[1500px] px-6 py-8 lg:px-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-5 border-b border-neutral-200 pb-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700">Skim</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-[-0.04em] text-neutral-950">Skill Manager</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-600">
            Review skill changes as Git transactions, prove the behavior on reloadable agents, and recover safely with Undo.
          </p>
        </div>
        <div className="rounded-xl border border-neutral-200 bg-white px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" aria-hidden="true" />
            Managed repository connected
          </div>
          <p className="mt-1 font-mono text-xs text-neutral-500">
            config {initialLoading ? "loading…" : shortCommit(registry?.configurationCommit)}
          </p>
        </div>
      </header>

      {error && errorView ? (
        <div
          role="alert"
          data-error-kind={errorView.title.toLowerCase().replaceAll(" ", "-")}
          className={`mb-6 rounded-xl border px-4 py-3 ${errorView.tone}`}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold">{errorView.title}</p>
              <p className="mt-1 text-sm">{error.message}</p>
              <p className="mt-1 font-mono text-[11px] opacity-70">{error.code}</p>
            </div>
            <button className="text-xs font-semibold underline" onClick={() => setError(null)}>Dismiss</button>
          </div>
        </div>
      ) : null}

      {success ? (
        <div role="status" className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {success}
        </div>
      ) : null}

      {initialLoading ? (
        <div className="rounded-2xl border border-neutral-200 bg-white p-8 text-sm text-neutral-500 shadow-sm">
          Loading repository, transaction history, and agent sessions…
        </div>
      ) : (
        <>
          <div className="grid gap-6 xl:grid-cols-[0.82fr_1.18fr]">
            <div className="space-y-6">
              <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
                <SectionHeading
                  eyebrow="Registry"
                  title="Skills"
                  detail={`${registry?.skills.length ?? 0} installed · version ${shortCommit(registry?.configurationCommit)}`}
                />
                <div className="space-y-3">
                  {(registry?.skills ?? []).length === 0 ? (
                    <p className="rounded-xl bg-neutral-50 px-4 py-6 text-center text-sm text-neutral-500">No skills installed.</p>
                  ) : (
                    registry?.skills.map((skill) => (
                      <div key={skill.id} className="rounded-xl border border-neutral-200 p-4" data-testid={`skill-${skill.id}`}>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="font-medium text-neutral-950">{skill.name}</p>
                            <p className="mt-1 font-mono text-[11px] text-neutral-500">{skill.id}</p>
                          </div>
                          <StatusPill active={skill.enabled}>{skill.enabled ? "Active" : "Paused"}</StatusPill>
                        </div>
                        <p className="mt-3 text-sm leading-5 text-neutral-600">{skill.description}</p>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {skill.scopes.tasks.map((scope) => (
                            <span key={scope} className="rounded-md bg-neutral-100 px-2 py-1 text-[11px] text-neutral-600">{scope}</span>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
                <SectionHeading eyebrow="Store" title="Add a skill" detail="Nothing changes until confirmation." />

                <div role="tablist" aria-label="Skill store" className="mb-4 flex gap-1 rounded-lg bg-neutral-100 p-1">
                  {STORE_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={storeTab === tab.id}
                      onClick={() => setStoreTab(tab.id)}
                      className={`flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                        storeTab === tab.id ? "bg-white text-neutral-950 shadow-sm" : "text-neutral-500 hover:text-neutral-800"
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {storeTab === "featured" ? (
                  <div className="space-y-3">
                    {catalog.length === 0 ? (
                      <p className="rounded-lg bg-neutral-50 px-3 py-6 text-center text-sm text-neutral-500">
                        No curated skills are available.
                      </p>
                    ) : (
                      catalog.map((entry) => {
                        const installed = installedSkillIds.has(entry.id);
                        return (
                          <article
                            key={entry.id}
                            data-testid={`catalog-${entry.id}`}
                            className="rounded-xl border border-neutral-200 p-3.5"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-medium text-neutral-900">{entry.name}</p>
                                <p className="font-mono text-xs text-neutral-500">
                                  {entry.source.subdirectory} · {shortCommit(entry.source.commit)}
                                </p>
                              </div>
                              <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
                                {entry.license}
                              </span>
                            </div>
                            <p className="mt-2 text-sm leading-relaxed text-neutral-600">{entry.description}</p>
                            <div className="mt-3 flex items-center justify-between gap-3">
                              <div className="flex flex-wrap gap-1.5">
                                {entry.tags.map((tag) => (
                                  <span key={tag} className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600">
                                    {tag}
                                  </span>
                                ))}
                              </div>
                              <button
                                type="button"
                                disabled={previewPending || installed}
                                onClick={() => void previewSource(entry.source)}
                                className="shrink-0 rounded-lg bg-neutral-950 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {installed ? "Installed" : "Preview"}
                              </button>
                            </div>
                          </article>
                        );
                      })
                    )}
                  </div>
                ) : null}

                {storeTab === "browse" ? (
                  <div className="space-y-4">
                    <form className="space-y-3" onSubmit={browseRepository}>
                      <label className="block text-sm font-medium text-neutral-700">
                        Repository URL
                        <input
                          aria-label="Repository URL"
                          type="url"
                          required
                          value={browseUrl}
                          onChange={(event) => setBrowseUrl(event.target.value)}
                          placeholder="https://github.com/org/repo.git"
                          className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm shadow-inner"
                        />
                      </label>
                      <label className="block text-sm font-medium text-neutral-700">
                        Commit SHA
                        <input
                          aria-label="Repository commit SHA"
                          required
                          pattern="[0-9a-fA-F]{40}"
                          value={browseCommit}
                          onChange={(event) => setBrowseCommit(event.target.value)}
                          placeholder="40-character commit"
                          className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 font-mono text-sm shadow-inner"
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={browsePending}
                        className="w-full rounded-lg bg-neutral-950 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {browsePending ? "Listing…" : "List skills"}
                      </button>
                    </form>

                    {browsedSkills === null ? null : browsedSkills.length === 0 ? (
                      <p className="rounded-lg bg-neutral-50 px-3 py-6 text-center text-sm text-neutral-500">
                        No SKILL.md directories at that commit.
                      </p>
                    ) : (
                      <div data-testid="browse-results" className="max-h-96 space-y-2 overflow-y-auto pr-1">
                        <p className="text-xs text-neutral-500">
                          {browsedSkills.length} skills at {shortCommit(browseCommit)}
                        </p>
                        {browsedSkills.map((skill) => (
                          <article
                            key={skill.subdirectory}
                            data-testid={`browsed-${skill.id}`}
                            className="rounded-xl border border-neutral-200 p-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-neutral-900">{skill.name}</p>
                                <p className="truncate font-mono text-xs text-neutral-500">{skill.subdirectory}</p>
                              </div>
                              <button
                                type="button"
                                disabled={previewPending || installedSkillIds.has(skill.id)}
                                onClick={() =>
                                  void previewSource({ url: browseUrl, commit: browseCommit, subdirectory: skill.subdirectory })
                                }
                                className="shrink-0 rounded-lg bg-neutral-950 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {installedSkillIds.has(skill.id) ? "Installed" : "Preview"}
                              </button>
                            </div>
                            <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-neutral-600">{skill.description}</p>
                            <p className="mt-1.5 text-[11px] text-neutral-500">
                              {skill.license} · {skill.fileCount} files
                            </p>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}

                {storeTab === "manual" ? (
                  <form className="space-y-4" onSubmit={createPreview}>
                    <label className="block text-sm font-medium text-neutral-700">
                      Git URL
                      <input
                        aria-label="Git URL"
                        type="url"
                        required
                        value={gitUrl}
                        onChange={(event) => setGitUrl(event.target.value)}
                        placeholder="https://github.com/org/repo.git"
                        className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm shadow-inner"
                      />
                    </label>
                    <label className="block text-sm font-medium text-neutral-700">
                      Commit SHA
                      <input
                        aria-label="Commit SHA"
                        required
                        pattern="[0-9a-fA-F]{40}"
                        value={commit}
                        onChange={(event) => setCommit(event.target.value)}
                        placeholder="40-character commit"
                        className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 font-mono text-sm shadow-inner"
                      />
                    </label>
                    <label className="block text-sm font-medium text-neutral-700">
                      Skill subdirectory
                      <input
                        aria-label="Skill subdirectory"
                        required
                        value={subdirectory}
                        onChange={(event) => setSubdirectory(event.target.value)}
                        placeholder="skills/npm-workflow"
                        className="mt-1.5 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 font-mono text-sm shadow-inner"
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={previewPending}
                      className="w-full rounded-lg bg-neutral-950 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {previewPending ? "Analyzing…" : "Generate preview"}
                    </button>
                  </form>
                ) : null}
              </section>
            </div>

            <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
              <SectionHeading
                eyebrow="Review"
                title={preview ? `Incoming: ${preview.incomingSkill.name}` : "Conflict evidence & diff"}
                detail={preview ? `base ${shortCommit(preview.baseCommit)}` : "Generate a preview to inspect the proposed change."}
              />

              {!preview ? (
                <div className="flex min-h-80 items-center justify-center rounded-xl border border-dashed border-neutral-300 bg-neutral-50 p-8 text-center">
                  <div>
                    <p className="text-sm font-medium text-neutral-700">No active preview</p>
                    <p className="mt-1 text-sm text-neutral-500">Conflict reports, citations, provider metadata, and the selected diff appear here.</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  {preview.conflicts.length === 0 ? (
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                      No semantic conflict candidate requires model analysis for this import.
                    </div>
                  ) : (
                    preview.conflicts.map((conflict, index) => (
                      <article key={`${conflict.skillAId}-${conflict.skillBId}-${index}`} className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700">Conflict scenario</p>
                            <h3 className="mt-1 font-semibold text-neutral-950">{conflict.commonScenario}</h3>
                          </div>
                          <div className="text-right">
                            <p className="text-xs font-semibold text-neutral-700">
                              {providerLabel(conflict.analysis.provider)} · {conflict.analysis.model}
                            </p>
                            <p className="mt-1 text-xs text-neutral-500">{Math.round(conflict.confidence * 100)}% confidence</p>
                          </div>
                        </div>
                        <p className="mt-3 text-sm leading-6 text-neutral-700">{conflict.explanation}</p>
                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          {conflict.evidence.map((evidence, evidenceIndex) => (
                            <div key={`${evidence.skillId}-${evidenceIndex}`} className="rounded-lg border border-amber-200 bg-white p-3">
                              <p className="font-mono text-[11px] text-neutral-500">
                                {evidence.skillId} · {evidence.filePath}:{evidence.lineStart}-{evidence.lineEnd}
                              </p>
                              <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-neutral-800">{evidence.quote}</pre>
                            </div>
                          ))}
                        </div>
                      </article>
                    ))
                  )}

                  <div>
                    <p className="mb-2 text-sm font-semibold text-neutral-800">Resolution</p>
                    <div className="grid gap-2 md:grid-cols-3">
                      {([
                        ["keep-existing", "Keep existing", "Install incoming paused"],
                        ["activate-incoming", "Activate incoming", "Pause conflicting active skills"],
                        ["cancel", "Cancel", "Create no commit"],
                      ] as const).map(([value, label, detail]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => {
                            setResolution(value);
                            setConfirmationOpen(false);
                          }}
                          aria-pressed={resolution === value}
                          className={[
                            "rounded-xl border p-3 text-left transition",
                            resolution === value
                              ? "border-neutral-950 bg-neutral-950 text-white"
                              : "border-neutral-200 bg-white hover:border-neutral-400",
                          ].join(" ")}
                        >
                          <span className="block text-sm font-semibold">{label}</span>
                          <span className={`mt-1 block text-xs ${resolution === value ? "text-neutral-300" : "text-neutral-500"}`}>{detail}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {selectedDiff ? (
                    <div>
                      <p className="mb-2 text-sm font-semibold text-neutral-800">Proposed file diff</p>
                      <pre className="max-h-96 overflow-auto rounded-xl bg-neutral-950 p-4 font-mono text-[11px] leading-5 text-neutral-200">{selectedDiff}</pre>
                    </div>
                  ) : null}

                  {!confirmationOpen ? (
                    <div className="flex justify-between gap-3 border-t border-neutral-200 pt-4">
                      <button
                        type="button"
                        className="text-sm font-medium text-neutral-500 underline"
                        onClick={() => {
                          setPreview(null);
                          setResolution(null);
                        }}
                      >
                        Discard preview
                      </button>
                      <button
                        type="button"
                        disabled={!resolution}
                        onClick={() => setConfirmationOpen(true)}
                        className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Review resolution
                      </button>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-neutral-300 bg-neutral-50 p-4">
                      <p className="text-sm font-semibold text-neutral-900">Explicit confirmation required</p>
                      <p className="mt-1 text-sm text-neutral-600">
                        {resolution === "cancel"
                          ? "This discards the preview and creates no Git commit."
                          : `This will commit the ${resolution} resolution against base ${shortCommit(preview.baseCommit)}.`}
                      </p>
                      <div className="mt-4 flex justify-end gap-2">
                        <button type="button" className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium" onClick={() => setConfirmationOpen(false)}>
                          Back
                        </button>
                        <button
                          type="button"
                          disabled={installPending}
                          onClick={confirmResolution}
                          className="rounded-lg bg-neutral-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                        >
                          {installPending ? "Committing…" : `Confirm ${resolution}`}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>

          <section className="mt-6 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
            <SectionHeading
              eyebrow="Behavior proof"
              title="Reloadable demo agents"
              detail="A repository commit does not change a loaded agent until Reload."
            />
            <div className="mb-4 flex items-end gap-3">
              <label className="flex-1 text-sm font-medium text-neutral-700">
                Task
                <input
                  aria-label="Agent task"
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
                />
              </label>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {["builder", "reviewer"].map((agentId) => {
                const status = agentStatuses[agentId];
                const run = agentRuns[agentId];
                const stale = Boolean(
                  status?.loadedConfigurationCommit &&
                  registry?.configurationCommit &&
                  status.loadedConfigurationCommit !== registry.configurationCommit,
                );
                return (
                  <article key={agentId} data-testid={`agent-${agentId}`} className="rounded-xl border border-neutral-200 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-neutral-950">{status?.name ?? agentId}</p>
                        <p className="mt-1 font-mono text-[11px] text-neutral-500">
                          loaded {shortCommit(status?.loadedConfigurationCommit)}
                        </p>
                      </div>
                      <StatusPill active={!stale}>{stale ? "Stale" : "Current"}</StatusPill>
                    </div>
                    <p className="mt-3 text-xs text-neutral-500">
                      Active skills: {status?.activeSkillIds.join(", ") || "none"}
                    </p>
                    <div className="mt-4 flex gap-2">
                      <button
                        type="button"
                        onClick={() => reloadAgent(agentId)}
                        disabled={Boolean(agentPending[agentId])}
                        className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-semibold disabled:opacity-50"
                      >
                        {agentPending[agentId] === "reload" ? "Reloading…" : "Reload"}
                      </button>
                      <button
                        type="button"
                        onClick={() => runAgent(agentId)}
                        disabled={Boolean(agentPending[agentId])}
                        className="rounded-lg bg-neutral-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                      >
                        {agentPending[agentId] === "run" ? "Running…" : "Run"}
                      </button>
                    </div>
                    {run ? (
                      <div className="mt-4 rounded-lg bg-neutral-950 p-3 text-neutral-100">
                        <p className="font-mono text-sm font-semibold">{run.interceptedExecutable} {run.interceptedArguments.join(" ")}</p>
                        <p className="mt-1 font-mono text-[11px] text-neutral-400">lockfile {run.expectedLockfile}</p>
                        <p className="mt-1 font-mono text-[11px] text-neutral-400">run config {shortCommit(run.configurationCommit)}</p>
                      </div>
                    ) : (
                      <p className="mt-4 rounded-lg bg-neutral-50 px-3 py-4 text-sm text-neutral-500">No run recorded in this browser session.</p>
                    )}
                  </article>
                );
              })}
            </div>
          </section>

          <section className="mt-6 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
            <SectionHeading eyebrow="Audit trail" title="Transaction history" detail="Undo always creates a recovery commit." />
            {transactions.length === 0 ? (
              <p className="rounded-xl bg-neutral-50 px-4 py-6 text-center text-sm text-neutral-500">No committed Skill Manager transactions yet.</p>
            ) : (
              <div className="divide-y divide-neutral-200">
                {transactions.map((transaction) => {
                  const alreadyUndone = transaction.type === "install" && undoneInstallIds.has(transaction.transactionId);
                  return (
                    <div key={transaction.transactionId} data-testid={`transaction-${transaction.transactionId}`} className="flex flex-wrap items-center justify-between gap-4 py-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <StatusPill active={transaction.type === "install"}>{transaction.type}</StatusPill>
                          <p className="font-mono text-xs text-neutral-600">{transaction.transactionId}</p>
                        </div>
                        <p className="mt-2 text-sm text-neutral-700">
                          {transaction.type === "install"
                            ? `resolution: ${transaction.resolution}`
                            : `recovers: ${transaction.originalTransactionId}`}
                        </p>
                        <p className="mt-1 font-mono text-[11px] text-neutral-500">
                          {shortCommit(transaction.beforeCommit)} → {shortCommit(transaction.afterCommit)}
                        </p>
                      </div>
                      {transaction.type === "install" ? (
                        <button
                          type="button"
                          disabled={alreadyUndone || undoPending === transaction.transactionId}
                          onClick={() => undoTransaction(transaction.transactionId)}
                          className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {alreadyUndone ? "Undone" : undoPending === transaction.transactionId ? "Undoing…" : "Undo"}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {undoConflict ? (
            <section className="mt-6 rounded-2xl border border-rose-300 bg-rose-50 p-5 shadow-sm" data-testid="undo-conflict">
              <SectionHeading eyebrow="Undo stopped" title="Affected files changed" detail={undoConflict.transactionId} />
              <p className="text-sm text-rose-900">{undoConflict.message}</p>
              <div className="mt-4 space-y-4">
                {undoConflict.files.map((file) => (
                  <article key={file.path} className="rounded-xl border border-rose-200 bg-white p-4">
                    <p className="font-mono text-xs font-semibold text-neutral-800">{file.path}</p>
                    <div className="mt-3 grid gap-3 xl:grid-cols-3">
                      {[
                        ["Before transaction", file.before],
                        ["Expected after", file.expectedAfter],
                        ["Current", file.current],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">{label}</p>
                          <pre className="max-h-48 overflow-auto rounded-lg bg-neutral-950 p-3 font-mono text-[11px] leading-5 text-neutral-200">{value ?? "<missing>"}</pre>
                        </div>
                      ))}
                    </div>
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm font-semibold text-neutral-700">Three-way diff</summary>
                      <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-neutral-950 p-3 font-mono text-[11px] leading-5 text-neutral-200">{file.threeWayDiff}</pre>
                    </details>
                  </article>
                ))}
              </div>
              <button type="button" className="mt-4 text-sm font-semibold underline" onClick={() => setUndoConflict(null)}>Close conflict details</button>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
