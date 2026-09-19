import type { TreeSource } from "../registry/tree-source";

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.[a-z0-9]+)?$/i;

const SIGNATURES: { id: string; pattern: RegExp }[] = [
  { id: "Apache-2.0", pattern: /Apache License\s+Version 2\.0/i },
  { id: "MPL-2.0", pattern: /Mozilla Public License Version 2\.0/i },
  { id: "GPL-3.0", pattern: /GNU GENERAL PUBLIC LICENSE\s+Version 3/i },
  { id: "AGPL-3.0", pattern: /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/i },
  { id: "LGPL-3.0", pattern: /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/i },
  { id: "BSD-3-Clause", pattern: /Neither the name of .{0,80}nor the names of its\s+contributors/i },
  { id: "ISC", pattern: /ISC License/i },
  { id: "MIT", pattern: /MIT License|Permission is hereby granted, free of charge/i },
];

export type LicenseDetails = { expression: string; files: string[] };

export function detectLicense(source: TreeSource, prefix: string, declared?: string): LicenseDetails {
  const files = source
    .list(prefix)
    .filter((entry) => entry.kind === "file" && !entry.path.includes("/") && LICENSE_FILE.test(entry.path))
    .map((entry) => entry.path)
    .sort();

  for (const file of files) {
    const head = source.read(prefix === "" ? file : `${prefix}/${file}`).subarray(0, 8192).toString("utf8");
    const match = SIGNATURES.find((signature) => signature.pattern.test(head));
    if (match) return { expression: match.id, files };
  }

  return { expression: declared?.trim() || "unspecified", files };
}
