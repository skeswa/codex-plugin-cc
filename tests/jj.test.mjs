import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  collectReviewContext,
  ensureRepository,
  getCurrentRef,
  getReviewSizeStats,
  resolveReviewTarget
} from "../plugins/codex/scripts/lib/jj.mjs";
import {
  initJjRepo,
  jjAvailable,
  jjBookmarkCreate,
  jjDescribe,
  jjNew,
  makeTempDir,
  run
} from "./helpers.mjs";

const skip = !jjAvailable();
const skipMessage = skip ? "jj is not installed" : undefined;

test("ensureRepository rejects non-jj directories", { skip, todo: skipMessage }, () => {
  const cwd = makeTempDir();
  assert.throws(
    () => ensureRepository(cwd),
    /must run inside a Jujutsu repository/
  );
});

test("auto scope returns chain since closest first-parent ancestor bookmark", { skip, todo: skipMessage }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.txt"), "v1\n");
  jjDescribe(cwd, "first");
  jjNew(cwd, "second");
  fs.writeFileSync(path.join(cwd, "a.txt"), "v2\n");
  jjBookmarkCreate(cwd, "checkpoint", "@-");
  jjNew(cwd, "third");
  fs.writeFileSync(path.join(cwd, "a.txt"), "v3\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "chain");
  assert.equal(target.vcsKind, "jj");
  assert.match(target.label, /checkpoint/);
});

test("@ on a bookmark skips past it to the previous bookmark", { skip, todo: skipMessage }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.txt"), "v1\n");
  jjDescribe(cwd, "first");
  jjBookmarkCreate(cwd, "first-bookmark", "@");
  jjNew(cwd, "second");
  fs.writeFileSync(path.join(cwd, "a.txt"), "v2\n");
  jjBookmarkCreate(cwd, "second-bookmark", "@");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "chain");
  assert.match(target.label, /first-bookmark/);
  assert.doesNotMatch(target.label, /second-bookmark/);
});

test("auto scope uses the first-parent bookmarked chain base for merge commits", { skip, todo: skipMessage }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.txt"), "base\n");
  jjDescribe(cwd, "base");
  jjBookmarkCreate(cwd, "main", "@");

  run("jj", ["new", "-m", "left", "main"], { cwd });
  fs.writeFileSync(path.join(cwd, "left.txt"), "left\n");
  jjBookmarkCreate(cwd, "left", "@");

  run("jj", ["new", "-m", "right", "main"], { cwd });
  fs.writeFileSync(path.join(cwd, "right.txt"), "right\n");
  jjBookmarkCreate(cwd, "right", "@");

  run("jj", ["new", "-m", "merge", "left", "right"], { cwd });
  fs.writeFileSync(path.join(cwd, "merge.txt"), "merge\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "chain");
  assert.match(target.label, /left/);
  assert.doesNotMatch(target.label, /right/);
  assert.equal(target.baseRevset, target.baseCommit);
  assert.match(context.content, /merge\.txt/);
  assert.match(context.content, /right\.txt/);
});

test("falls back to trunk() when no ancestor bookmark exists", { skip, todo: skipMessage }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.txt"), "v1\n");
  jjDescribe(cwd, "first");
  jjBookmarkCreate(cwd, "main", "@");
  jjNew(cwd, "second");
  fs.writeFileSync(path.join(cwd, "a.txt"), "v2\n");
  jjNew(cwd, "third");
  fs.writeFileSync(path.join(cwd, "a.txt"), "v3\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "chain");
  assert.match(target.label, /main/);
});

test("throws when no bookmark and no trunk are reachable", { skip, todo: skipMessage }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /no ancestor bookmark and no trunk/
  );
});

test("--scope working-tree maps to @-..@", { skip, todo: skipMessage }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.txt"), "v1\n");
  jjDescribe(cwd, "first");
  jjNew(cwd, "second");
  fs.writeFileSync(path.join(cwd, "a.txt"), "v2\n");

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });

  assert.equal(target.mode, "working-tree");
  assert.equal(target.baseRevset, "@-");
  assert.equal(target.tipRevset, "@");
});

test("--base honors explicit revset", { skip, todo: skipMessage }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.txt"), "v1\n");
  jjDescribe(cwd, "first");
  jjBookmarkCreate(cwd, "checkpoint", "@");
  jjNew(cwd, "second");
  fs.writeFileSync(path.join(cwd, "a.txt"), "v2\n");

  const target = resolveReviewTarget(cwd, { base: "checkpoint" });

  assert.equal(target.mode, "chain");
  assert.equal(target.baseRevset, "checkpoint");
  assert.equal(target.explicit, true);
});

test("collectReviewContext keeps inline diff for tiny chains", { skip, todo: skipMessage }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  jjDescribe(cwd, "first");
  jjBookmarkCreate(cwd, "checkpoint", "@");
  jjNew(cwd, "second");
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.match(context.content, /INLINE_MARKER/);
  assert.match(context.collectionGuidance, /primary evidence/i);
});

test("collectReviewContext falls back to lightweight context above the byte threshold", { skip, todo: skipMessage }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "v1\n");
  jjDescribe(cwd, "first");
  jjBookmarkCreate(cwd, "checkpoint", "@");
  jjNew(cwd, "second");
  fs.writeFileSync(path.join(cwd, "app.js"), `${"x".repeat(512)}\n`);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 });

  assert.equal(context.inputMode, "self-collect");
  assert.ok(context.diffBytes > 128);
  assert.doesNotMatch(context.content, /xxx/);
  assert.match(context.content, /## Changed Files/);
});

test("getReviewSizeStats reports branchBehind 0 for an up-to-date linear chain", { skip, todo: skipMessage }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.txt"), "v1\n");
  jjDescribe(cwd, "first");
  jjBookmarkCreate(cwd, "checkpoint", "@");
  jjNew(cwd, "second");
  fs.writeFileSync(path.join(cwd, "a.txt"), "v2\n");

  const target = resolveReviewTarget(cwd, {});
  const stats = getReviewSizeStats(cwd, target);

  assert.equal(stats.branchBehind, 0);
});

test("chain mode excludes upstream commits when tip is behind base", { skip, todo: skipMessage }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.txt"), "v1\n");
  jjDescribe(cwd, "base");
  jjBookmarkCreate(cwd, "main", "@");

  jjNew(cwd, "advance-main");
  fs.writeFileSync(path.join(cwd, "upstream-only.txt"), "upstream-only\n");
  run("jj", ["bookmark", "set", "main", "-r", "@"], { cwd });

  run("jj", ["new", "-m", "feature", "main-"], { cwd });
  fs.writeFileSync(path.join(cwd, "feature.txt"), "feature\n");

  const target = resolveReviewTarget(cwd, { base: "main" });

  const stats = getReviewSizeStats(cwd, target);
  assert.equal(stats.branchBehind, 1);
  assert.equal(stats.fileCount, 1);
  assert.equal(stats.linesAdded, 1);
  assert.equal(stats.linesRemoved, 0);

  const context = collectReviewContext(cwd, target);
  assert.match(context.content, /## Branch State/);
  assert.match(context.content, /1 commit behind/);
  assert.match(context.content, /feature\.txt/);
  assert.doesNotMatch(context.content, /upstream-only\.txt/);
});

test("chain mode with internal merge commits behind base still excludes upstream content", { skip, todo: skipMessage }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.txt"), "v1\n");
  jjDescribe(cwd, "base");
  jjBookmarkCreate(cwd, "main", "@");

  jjNew(cwd, "main-1");
  fs.writeFileSync(path.join(cwd, "main1.txt"), "main1\n");
  jjNew(cwd, "main-2");
  fs.writeFileSync(path.join(cwd, "main2.txt"), "main2\n");
  run("jj", ["bookmark", "set", "main", "-r", "@"], { cwd });

  run("jj", ["new", "-m", "feature1", "main--"], { cwd });
  fs.writeFileSync(path.join(cwd, "feature1.txt"), "feature1\n");

  run("jj", ["new", "-m", "merge-feature-with-main-1", "@", "main-"], { cwd });
  fs.writeFileSync(path.join(cwd, "feature2.txt"), "feature2\n");

  const target = resolveReviewTarget(cwd, { base: "main" });

  const stats = getReviewSizeStats(cwd, target);
  assert.equal(stats.branchBehind, 1);
  assert.ok(stats.fileCount >= 2);

  const context = collectReviewContext(cwd, target);
  assert.match(context.content, /## Branch State/);
  assert.match(context.content, /feature1\.txt/);
  assert.match(context.content, /feature2\.txt/);
  assert.doesNotMatch(context.content, /main2\.txt/);
});

test("getCurrentRef returns bookmark name when @ is bookmarked", { skip, todo: skipMessage }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.txt"), "v1\n");
  jjDescribe(cwd, "first");
  jjBookmarkCreate(cwd, "feature/test", "@");

  assert.match(getCurrentRef(cwd), /feature\/test/);
});
