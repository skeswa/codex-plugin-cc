import { ensureRepository } from "./vcs.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureRepository(cwd);
  } catch {
    return cwd;
  }
}
