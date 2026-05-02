import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  collectReviewContext,
  ensureRepository,
  getCurrentRef,
  resolveReviewTarget
} from "../plugins/codex/scripts/lib/jj.mjs";
import {
  initJjRepo,
  jjAvailable,
  jjBookmarkCreate,
  jjDescribe,
  jjNew,
  makeTempDir
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

test("auto scope returns chain since closest ancestor bookmark", { skip, todo: skipMessage }, () => {
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

test("getCurrentRef returns bookmark name when @ is bookmarked", { skip, todo: skipMessage }, () => {
  const cwd = makeTempDir();
  initJjRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.txt"), "v1\n");
  jjDescribe(cwd, "first");
  jjBookmarkCreate(cwd, "feature/test", "@");

  assert.match(getCurrentRef(cwd), /feature\/test/);
});
