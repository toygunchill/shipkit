/**
 * Turning a path a caller gave shipkit into the path git would spell it as, relative to the
 * repository root — the first half of keeping shipkit's own files out of the commit.
 *
 * Both sides go through realpath first. `git rev-parse --show-toplevel` resolves symbolic
 * links and `resolve` does not, so on a checkout reached through one (macOS puts every
 * temporary directory behind /var -> /private/var) the two spellings of the same directory
 * would not match. The mismatch fails quietly in the worst direction: the file is judged to
 * be outside the repository, the exclusion is skipped, and it lands in the commit.
 *
 * The result is spelled the way git spells paths. `relative` uses the platform separator,
 * `git ls-files --full-name` always answers with forward slashes, and the two are compared
 * to each other and handed to a pathspec — so on Windows the exclusion would miss and the
 * file would be reported as untracked on every run.
 *
 * `undefined` means the path is not inside the repository, in which case there is nothing to
 * exclude: git rejects an out-of-tree pathspec outright, and staging can never reach it
 * anyway.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export type PathDeps = {
  readRepoRoot: () => string;
  realpath: (path: string) => string;
};

export function repoRelative(path: string, deps: PathDeps): string | undefined {
  const repoRoot = deps.realpath(deps.readRepoRoot());
  const spelled = relative(repoRoot, deps.realpath(resolve(path))).split(sep).join("/");
  if (spelled.length === 0 || spelled.startsWith("..") || isAbsolute(spelled)) return undefined;
  return spelled;
}
