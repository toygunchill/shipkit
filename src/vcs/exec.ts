import { execFileSync } from "node:child_process";
import { VcsError } from "./types.js";

/**
 * Runs `fn`, wrapping any thrown error into a `VcsError` that names the command that
 * failed. An error that is already a `VcsError` is re-thrown untouched — `fn` may itself
 * call something that already produced one (e.g. a JSON-parsing step running on top of an
 * `execRunner` result), and that error's message is already the right one.
 */
export function asVcsError<T>(binary: string, args: string[], fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof VcsError) throw error;
    const detail =
      (error as { stderr?: string }).stderr ??
      (error instanceof Error ? error.message : String(error));
    throw new VcsError(`${binary} ${args.join(" ")} failed: ${detail.trim()}`);
  }
}

/**
 * Builds a runner that invokes `binary` via `execFileSync`, converting a failure into a
 * `VcsError`. `cwd` is optional: git.ts needs it (its tests run against scratch
 * repositories), the gh-backed callers in github.ts and mutate.ts never pass one.
 */
export function execRunner(binary: string, cwd?: string): (args: string[]) => string {
  return (args: string[]) =>
    asVcsError(binary, args, () =>
      execFileSync(binary, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    );
}
