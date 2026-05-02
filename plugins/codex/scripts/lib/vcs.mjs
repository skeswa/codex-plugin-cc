import fs from "node:fs";
import path from "node:path";

import * as gitBackend from "./git.mjs";
import * as jjBackend from "./jj.mjs";
import { runCommand } from "./process.mjs";

const detectionCache = new Map();

function findAncestorWith(startDir, marker) {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, marker);
    try {
      if (fs.statSync(candidate)) {
        return current;
      }
    } catch {
      // not present, ascend
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function detectVcs(cwd) {
  const key = path.resolve(cwd);
  if (detectionCache.has(key)) {
    return detectionCache.get(key);
  }
  const jjRoot = findAncestorWith(key, ".jj");
  if (jjRoot) {
    const result = { kind: "jj", root: jjRoot };
    detectionCache.set(key, result);
    return result;
  }
  const gitRoot = findAncestorWith(key, ".git");
  if (gitRoot) {
    const result = { kind: "git", root: gitRoot };
    detectionCache.set(key, result);
    return result;
  }
  return null;
}

function requireDetection(cwd) {
  const detection = detectVcs(cwd);
  if (!detection) {
    throw new Error("This command must run inside a Git or Jujutsu repository.");
  }
  return detection;
}

export function ensureRepository(cwd) {
  const detection = requireDetection(cwd);
  if (detection.kind === "jj") {
    return jjBackend.ensureRepository(cwd);
  }
  return gitBackend.ensureGitRepository(cwd);
}

export function ensureGitRepository(cwd) {
  return ensureRepository(cwd);
}

export function getRepoRoot(cwd) {
  const detection = requireDetection(cwd);
  if (detection.kind === "jj") {
    return jjBackend.getRepoRoot(cwd);
  }
  return gitBackend.getRepoRoot(cwd);
}

export function getCurrentRef(cwd) {
  const detection = requireDetection(cwd);
  if (detection.kind === "jj") {
    return jjBackend.getCurrentRef(cwd);
  }
  return gitBackend.getCurrentBranch(cwd);
}

export function resolveReviewTarget(cwd, options = {}) {
  const detection = requireDetection(cwd);
  const target =
    detection.kind === "jj"
      ? jjBackend.resolveReviewTarget(cwd, options)
      : gitBackend.resolveReviewTarget(cwd, options);
  if (!target.vcsKind) {
    target.vcsKind = detection.kind;
  }
  return target;
}

export function collectReviewContext(cwd, target, options = {}) {
  const detection = requireDetection(cwd);
  if (detection.kind === "jj") {
    return jjBackend.collectReviewContext(cwd, target, options);
  }
  return gitBackend.collectReviewContext(cwd, target, options);
}

export function getReviewSizeStats(cwd, target) {
  const detection = requireDetection(cwd);
  if (detection.kind === "jj") {
    return jjBackend.getReviewSizeStats(cwd, target);
  }
  return getGitReviewSizeStats(cwd, target);
}

function parseShortStat(text, fallbackFileCount) {
  const lastLine = text.split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";
  const fileMatch = lastLine.match(/(\d+)\s+files?\s+changed/);
  const insertedMatch = lastLine.match(/(\d+)\s+insertions?\(\+\)/);
  const deletedMatch = lastLine.match(/(\d+)\s+deletions?\(-\)/);
  return {
    fileCount: fileMatch ? Number(fileMatch[1]) : fallbackFileCount,
    linesAdded: insertedMatch ? Number(insertedMatch[1]) : 0,
    linesRemoved: deletedMatch ? Number(deletedMatch[1]) : 0
  };
}

function gitShortStat(cwd, args) {
  const result = runCommand("git", args, { cwd });
  if (result.error || result.status !== 0) {
    return "";
  }
  return result.stdout;
}

function getGitReviewSizeStats(cwd, target) {
  const repoRoot = gitBackend.getRepoRoot(cwd);
  if (target.mode === "working-tree") {
    const staged = gitShortStat(repoRoot, ["diff", "--shortstat", "--cached"]);
    const unstaged = gitShortStat(repoRoot, ["diff", "--shortstat"]);
    const stagedStats = parseShortStat(staged, 0);
    const unstagedStats = parseShortStat(unstaged, 0);
    const context = gitBackend.collectReviewContext(repoRoot, target, { includeDiff: false });
    return {
      fileCount: context.fileCount,
      linesAdded: stagedStats.linesAdded + unstagedStats.linesAdded,
      linesRemoved: stagedStats.linesRemoved + unstagedStats.linesRemoved
    };
  }
  const range = `${target.baseRef}...HEAD`;
  const stat = gitShortStat(repoRoot, ["diff", "--shortstat", range]);
  const context = gitBackend.collectReviewContext(repoRoot, target, { includeDiff: false });
  return parseShortStat(stat, context.fileCount);
}

export function _resetDetectionCacheForTests() {
  detectionCache.clear();
}
