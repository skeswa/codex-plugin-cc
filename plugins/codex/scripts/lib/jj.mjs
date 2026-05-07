import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_INLINE_DIFF_FILES = 2;
const MAX_INLINE_DIFF_BYTES = 256 * 1024;

const TRUNK_REVSET = "trunk()";
const ROOT_REVSET = "root()";

function jj(cwd, args, options = {}) {
  return runCommand("jj", args, { cwd, ...options });
}

function jjChecked(cwd, args, options = {}) {
  return runCommandChecked("jj", args, { cwd, ...options });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return MAX_INLINE_DIFF_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return MAX_INLINE_DIFF_BYTES;
  }
  return Math.floor(parsed);
}

function measureJjOutputBytes(cwd, args, maxBytes) {
  const result = jj(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

export function ensureRepository(cwd) {
  const result = jj(cwd, ["root"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("jj is not installed. Install Jujutsu and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Jujutsu repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return jjChecked(cwd, ["root"]).stdout.trim();
}

function resolveRevsetToCommit(cwd, revset) {
  const result = jjChecked(cwd, [
    "log",
    "-r",
    revset,
    "--no-graph",
    "--limit",
    "1",
    "-T",
    'commit_id ++ "\\n"'
  ]);
  return result.stdout.trim();
}

function bookmarksAt(cwd, revset) {
  const result = jjChecked(cwd, [
    "log",
    "-r",
    revset,
    "--no-graph",
    "--limit",
    "1",
    "-T",
    'bookmarks.join(",")'
  ]);
  return result.stdout.trim();
}

function trunkIsRoot(cwd) {
  const result = jj(cwd, [
    "log",
    "-r",
    `${TRUNK_REVSET} & ~${ROOT_REVSET}`,
    "--no-graph",
    "--limit",
    "1",
    "-T",
    'commit_id ++ "\\n"'
  ]);
  if (result.status !== 0) {
    return true;
  }
  return result.stdout.trim() === "";
}

function chainBaseRevset(cwd, tipRevset = "@") {
  const closest = resolveRevsetToCommit(
    cwd,
    `heads(::first_parent(${tipRevset}) & bookmarks())`
  );
  if (closest) {
    return { revset: closest, commit: closest, source: "bookmark" };
  }
  if (!trunkIsRoot(cwd)) {
    const trunkCommit = resolveRevsetToCommit(cwd, TRUNK_REVSET);
    if (trunkCommit) {
      return { revset: TRUNK_REVSET, commit: trunkCommit, source: "trunk" };
    }
  }
  return null;
}

export function getCurrentRef(cwd) {
  const bookmarks = bookmarksAt(cwd, "@");
  if (bookmarks) {
    return bookmarks;
  }
  const result = jjChecked(cwd, [
    "log",
    "-r",
    "@",
    "--no-graph",
    "--limit",
    "1",
    "-T",
    'change_id.short()'
  ]);
  return result.stdout.trim() || "@";
}

function describeBase(cwd, base) {
  if (base.source === "bookmark") {
    const bookmarks = bookmarksAt(cwd, base.commit);
    if (bookmarks) {
      return `bookmark ${bookmarks}`;
    }
    return base.commit.slice(0, 12);
  }
  if (base.source === "trunk") {
    const bookmarks = bookmarksAt(cwd, base.commit);
    if (bookmarks) {
      return `trunk (${bookmarks})`;
    }
    return "trunk()";
  }
  return base.revset;
}

function workingCopyHasChanges(cwd) {
  const result = jjChecked(cwd, [
    "log",
    "-r",
    "@ & ~empty()",
    "--no-graph",
    "--limit",
    "1",
    "-T",
    'commit_id ++ "\\n"'
  ]);
  return result.stdout.trim() !== "";
}

// When `@` is the empty working copy left behind by `jj squash`, treating
// `@` as the chain tip yields an empty diff against the parent bookmark.
// Walk through any trailing empty commits to find the deepest non-empty
// ancestor and use that as the effective tip.
function effectiveTipRevset(cwd) {
  if (workingCopyHasChanges(cwd)) {
    return "@";
  }
  const result = jjChecked(cwd, [
    "log",
    "-r",
    "heads(::@ & ~empty())",
    "--no-graph",
    "--limit",
    "1",
    "-T",
    'commit_id ++ "\\n"'
  ]);
  return result.stdout.trim() || "@";
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const supportedScopes = new Set(["auto", "working-tree", "branch", "chain"]);

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, chain, working-tree, branch, or pass --base <revset>.`
    );
  }

  if (baseRef) {
    return {
      mode: "chain",
      label: `chain since ${baseRef}`,
      baseRevset: baseRef,
      tipRevset: "@",
      vcsKind: "jj",
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working-copy commit (@-..@)",
      baseRevset: "@-",
      tipRevset: "@",
      vcsKind: "jj",
      explicit: true
    };
  }

  if (requestedScope === "branch") {
    if (trunkIsRoot(cwd)) {
      throw new Error(
        "Unable to detect a trunk for branch-scope review. Configure trunk() in jj or pass --base <revset>."
      );
    }
    return {
      mode: "chain",
      label: "chain since trunk()",
      baseRevset: TRUNK_REVSET,
      tipRevset: "@",
      vcsKind: "jj",
      explicit: true
    };
  }

  const tipRevset = effectiveTipRevset(cwd);
  const base = chainBaseRevset(cwd, tipRevset);
  if (!base) {
    throw new Error(
      "Unable to detect a chain base: no ancestor bookmark and no trunk(). Pass --base <revset> or use --scope working-tree."
    );
  }
  const description = describeBase(cwd, base);
  return {
    mode: "chain",
    label: `chain since ${description}`,
    baseRevset: base.revset,
    baseCommit: base.commit,
    baseSource: base.source,
    tipRevset,
    vcsKind: "jj",
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

// Resolve the most recent shared ancestor of base and tip. For linear chains
// where tip descends from base, this equals base itself; for chains that have
// merged upstream content (or branched off an older commit), it's the integration
// point on the base side. Diffing from the merge-base means upstream-only commits
// never appear as either additions or deletions in the chain diff.
function chainMergeBase(cwd, target) {
  if (target.mode !== "chain") {
    return null;
  }
  if (target.__mergeBase != null) {
    return target.__mergeBase;
  }
  const result = jjChecked(cwd, [
    "log",
    "-r",
    `heads(::(${target.baseRevset}) & ::(${target.tipRevset}))`,
    "--no-graph",
    "-T",
    'commit_id ++ "\\n"'
  ]);
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    throw new Error(
      `Chain base "${target.baseRevset}" has ${lines.length} merge bases with the tip. ` +
        `Pass an unambiguous revset via --base.`
    );
  }
  const value = lines[0] ?? target.baseRevset;
  Object.defineProperty(target, "__mergeBase", {
    value,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return value;
}

function jjDiffArgs(cwd, target, extra = []) {
  if (target.mode !== "chain") {
    return ["diff", ...extra, "--from", target.baseRevset, "--to", target.tipRevset];
  }
  const fromRevset = chainMergeBase(cwd, target);
  return ["diff", ...extra, "--from", fromRevset, "--to", target.tipRevset];
}

function listChangedFiles(cwd, target) {
  const result = jjChecked(cwd, jjDiffArgs(cwd, target, ["--name-only"]));
  return result.stdout.trim().split("\n").filter(Boolean);
}

function fullDiff(cwd, target) {
  return jjChecked(cwd, jjDiffArgs(cwd, target, ["--git"])).stdout;
}

function diffStat(cwd, target) {
  return jjChecked(cwd, jjDiffArgs(cwd, target, ["--stat"])).stdout.trim();
}

function commitsBehind(cwd, target) {
  if (target.mode !== "chain") {
    return 0;
  }
  const result = jjChecked(cwd, [
    "log",
    "-r",
    `${target.tipRevset}..${target.baseRevset}`,
    "--no-graph",
    "-T",
    '"x\\n"'
  ]);
  return result.stdout.split("\n").filter(Boolean).length;
}

function chainLog(cwd, fromRevset, toRevset) {
  const range = `${fromRevset}..${toRevset}`;
  const template = 'change_id.short() ++ " " ++ if(description, description.first_line(), "(no description)") ++ if(bookmarks, " [" ++ bookmarks.join(",") ++ "]", "") ++ "\\n"';
  const result = jjChecked(cwd, ["log", "-r", range, "--no-graph", "-T", template]);
  return result.stdout.trim();
}

function statusOutput(cwd) {
  return jjChecked(cwd, ["status"]).stdout.trim();
}

function buildAdversarialCollectionGuidance(includeDiff) {
  if (includeDiff) {
    return "Use the repository context below as primary evidence.";
  }
  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only jj commands before finalizing findings.";
}

function buildBranchStateBody(branchBehind, baseRevset) {
  const noun = branchBehind === 1 ? "commit" : "commits";
  return [
    `Tip is ${branchBehind} ${noun} behind the chain base (\`${baseRevset}\`).`,
    "The diff below reflects only the chain's own changes; it does NOT include those upstream commits.",
    "Do not interpret missing upstream content as deletions in the chain."
  ].join(" ");
}

function collectChainContext(cwd, target, options = {}) {
  const fromRevset = target.baseRevset;
  const toRevset = target.tipRevset;
  const changedFiles = listChangedFiles(cwd, target);
  const log = chainLog(cwd, fromRevset, toRevset);
  const stat = diffStat(cwd, target);
  const branchBehind = commitsBehind(cwd, target);

  const parts = [];
  if (branchBehind > 0) {
    parts.push(formatSection("Branch State", buildBranchStateBody(branchBehind, fromRevset)));
  }
  parts.push(formatSection("Status", statusOutput(cwd)));
  parts.push(formatSection("Commit Log", log));
  parts.push(formatSection("Diff Stat", stat));

  if (options.includeDiff !== false) {
    parts.push(formatSection("Chain Diff", fullDiff(cwd, target)));
  } else {
    parts.push(formatSection("Changed Files", changedFiles.join("\n")));
  }

  const summary = `Reviewing ${target.label} from ${fromRevset} to ${toRevset}.`;
  return {
    mode: target.mode,
    summary,
    content: parts.join("\n"),
    changedFiles,
    branchBehind
  };
}

function collectWorkingCopyContext(cwd, target, options = {}) {
  const changedFiles = listChangedFiles(cwd, target);
  const stat = diffStat(cwd, target);

  const parts = [
    formatSection("Status", statusOutput(cwd)),
    formatSection("Diff Stat", stat)
  ];

  if (options.includeDiff !== false) {
    parts.push(formatSection("Working Copy Diff", fullDiff(cwd, target)));
  } else {
    parts.push(formatSection("Changed Files", changedFiles.join("\n")));
  }

  const summary = `Reviewing working-copy commit (${changedFiles.length} file(s) changed).`;
  return {
    mode: target.mode,
    summary,
    content: parts.join("\n"),
    changedFiles
  };
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentRef = getCurrentRef(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);

  const changedFiles = listChangedFiles(repoRoot, target);
  const diffBytes = measureJjOutputBytes(
    repoRoot,
    jjDiffArgs(repoRoot, target, ["--git"]),
    maxInlineDiffBytes
  );

  const includeDiff =
    options.includeDiff ?? (changedFiles.length <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);

  const details =
    target.mode === "working-tree"
      ? collectWorkingCopyContext(repoRoot, target, { includeDiff })
      : collectChainContext(repoRoot, target, { includeDiff });

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentRef,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance(includeDiff),
    ...details
  };
}

export function getReviewSizeStats(cwd, target) {
  const repoRoot = getRepoRoot(cwd);
  const changedFiles = listChangedFiles(repoRoot, target);
  const stat = diffStat(repoRoot, target);
  const stats = parseShortStat(stat, changedFiles.length);
  return { ...stats, branchBehind: commitsBehind(repoRoot, target) };
}

function parseShortStat(stat, fallbackFileCount) {
  const lastLine = stat.split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";
  const fileMatch = lastLine.match(/(\d+)\s+files?\s+changed/);
  const insertedMatch = lastLine.match(/(\d+)\s+insertions?\(\+\)/);
  const deletedMatch = lastLine.match(/(\d+)\s+deletions?\(-\)/);
  return {
    fileCount: fileMatch ? Number(fileMatch[1]) : fallbackFileCount,
    linesAdded: insertedMatch ? Number(insertedMatch[1]) : 0,
    linesRemoved: deletedMatch ? Number(deletedMatch[1]) : 0
  };
}
