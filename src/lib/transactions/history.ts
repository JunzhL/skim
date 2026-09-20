import { z } from "zod";
import {
  identifierSchema,
  installResolutionSchema,
  relativePosixPathSchema,
  sha256Schema,
  transactionRecordSchema,
  utcTimestampSchema,
  type TransactionRecord,
} from "../contracts";
import { SkimError } from "../errors";
import { git, gitBuffer, headCommit, repositoryRoot } from "../git";

const TRANSACTIONS_DIRECTORY = ".skim/transactions";
const SELF_COMMIT = "self";

const affectedPathHashSchema = z.object({
  path: relativePosixPathSchema,
  beforeHash: sha256Schema.nullable(),
  afterHash: sha256Schema.nullable(),
});

const persistedBaseSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: identifierSchema,
  beforeCommit: z.string().regex(/^[0-9a-f]{40}$/),
  afterCommit: z.literal(SELF_COMMIT),
  affectedPathHashes: z.array(affectedPathHashSchema),
  createdAt: utcTimestampSchema,
});

const persistedTransactionSchema = z.discriminatedUnion("type", [
  persistedBaseSchema.extend({
    type: z.literal("install"),
    resolution: installResolutionSchema,
  }),
  persistedBaseSchema.extend({
    type: z.literal("undo"),
    originalTransactionId: identifierSchema,
  }),
]);

function transactionPaths(repoPath: string, commit: string): string[] {
  const output = git(repoPath, [
    "ls-tree",
    "-r",
    "--name-only",
    commit,
    "--",
    TRANSACTIONS_DIRECTORY,
  ]);
  if (output === "") return [];
  return output
    .split("\n")
    .filter((path) => path.startsWith(`${TRANSACTIONS_DIRECTORY}/`) && path.endsWith(".json"))
    .sort();
}

function creationCommit(repoPath: string, path: string): string {
  const commits = git(repoPath, [
    "log",
    "--diff-filter=A",
    "--format=%H",
    "--",
    path,
  ])
    .split("\n")
    .filter(Boolean);

  if (commits.length !== 1) {
    throw new SkimError(
      "TRANSACTION_INVALID",
      `Transaction history for ${path} does not have exactly one creation commit`,
      { path, commits },
    );
  }
  return commits[0];
}

function parsePersistedTransaction(repoPath: string, commit: string, path: string): TransactionRecord {
  const raw = gitBuffer(repoPath, ["show", `${commit}:${path}`]);
  let document: unknown;
  try {
    document = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new SkimError("TRANSACTION_INVALID", `Transaction record ${path} is not valid JSON`, { path });
  }

  const parsed = persistedTransactionSchema.safeParse(document);
  if (!parsed.success) {
    throw new SkimError(
      "TRANSACTION_INVALID",
      `Transaction record ${path} does not match the persisted schema`,
      {
        path,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    );
  }

  const afterCommit = creationCommit(repoPath, path);

  if (parsed.data.type === "install") {
    return transactionRecordSchema.parse({
      transactionId: parsed.data.transactionId,
      type: "install",
      resolution: parsed.data.resolution,
      beforeCommit: parsed.data.beforeCommit,
      afterCommit,
      affectedPathHashes: parsed.data.affectedPathHashes,
      createdAt: parsed.data.createdAt,
    });
  }

  return transactionRecordSchema.parse({
    transactionId: parsed.data.transactionId,
    type: "undo",
    originalTransactionId: parsed.data.originalTransactionId,
    beforeCommit: parsed.data.beforeCommit,
    afterCommit,
    affectedPathHashes: parsed.data.affectedPathHashes,
    createdAt: parsed.data.createdAt,
  });
}

export function listTransactionHistory(repoPathInput: string): TransactionRecord[] {
  const repoPath = repositoryRoot(repoPathInput);
  const commit = headCommit(repoPath);
  return transactionPaths(repoPath, commit)
    .map((path) => parsePersistedTransaction(repoPath, commit, path))
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      left.transactionId.localeCompare(right.transactionId),
    );
}
