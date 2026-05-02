import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  _resetDetectionCacheForTests,
  detectVcs,
  ensureRepository,
  resolveReviewTarget
} from "../plugins/codex/scripts/lib/vcs.mjs";
import { initGitRepo, initJjRepo, jjAvailable, makeTempDir, run } from "./helpers.mjs";

test("detectVcs prefers .jj over .git in a colocated repo", { skip: !jjAvailable() }, () => {
  _resetDetectionCacheForTests();
  const cwd = makeTempDir();
  initGitRepo(cwd);
  initJjRepo(cwd);

  const detection = detectVcs(cwd);

  assert.equal(detection.kind, "jj");
  assert.equal(fs.realpathSync(detection.root), fs.realpathSync(cwd));
});

test("detectVcs returns git when only .git is present", () => {
  _resetDetectionCacheForTests();
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.txt"), "v1\n");
  run("git", ["add", "a.txt"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const detection = detectVcs(cwd);

  assert.equal(detection.kind, "git");
});

test("detectVcs ascends from a subdirectory", () => {
  _resetDetectionCacheForTests();
  const root = makeTempDir();
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "a.txt"), "v1\n");
  run("git", ["add", "a.txt"], { cwd: root });
  run("git", ["commit", "-m", "init"], { cwd: root });
  const nested = path.join(root, "deep", "nested");
  fs.mkdirSync(nested, { recursive: true });

  const detection = detectVcs(nested);

  assert.equal(detection.kind, "git");
  assert.equal(fs.realpathSync(detection.root), fs.realpathSync(root));
});

test("detectVcs prefers a nearer nested git repo over an ancestor jj repo", { skip: !jjAvailable() }, () => {
  _resetDetectionCacheForTests();
  const root = makeTempDir();
  initJjRepo(root);
  const nested = path.join(root, "nested-git");
  fs.mkdirSync(nested);
  initGitRepo(nested);

  const detection = detectVcs(nested);

  assert.equal(detection.kind, "git");
  assert.equal(fs.realpathSync(detection.root), fs.realpathSync(nested));
});

test("ensureRepository throws a clear error in a bare directory", () => {
  _resetDetectionCacheForTests();
  const cwd = makeTempDir();

  assert.throws(
    () => ensureRepository(cwd),
    /must run inside a Git or Jujutsu repository/
  );
});

test("resolveReviewTarget routes to the git backend when .git is present", () => {
  _resetDetectionCacheForTests();
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.txt"), "v1\n");
  run("git", ["add", "a.txt"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.txt"), "v2\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
  assert.equal(target.vcsKind, "git");
});

test("resolveReviewTarget routes to the jj backend when .jj is present", { skip: !jjAvailable() }, () => {
  _resetDetectionCacheForTests();
  const cwd = makeTempDir();
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.txt"), "v1\n");
  run("jj", ["describe", "-m", "first"], { cwd });
  run("jj", ["bookmark", "create", "checkpoint", "-r", "@"], { cwd });
  run("jj", ["new", "-m", "second"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.txt"), "v2\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "chain");
  assert.equal(target.vcsKind, "jj");
});
