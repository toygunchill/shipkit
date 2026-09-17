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
 * How much a command may print before `execFileSync` gives up.
 *
 * Node's default is one mebibyte, and exceeding it throws `ENOBUFS` — an error carrying no
 * stderr at all, so `asVcsError` below reports the command with an empty reason. Every read
 * in this project produced small output until `readPushDiff` arrived and read a whole patch.
 * Measured on scratch repositories: 12,000 added lines of ordinary source came back; 16,000
 * threw, and `shipkit review` exited 2 saying nothing. That is the size of a real generated
 * change, and the one size at which reviewing it mattered most.
 *
 * 256 MiB is chosen to be past any diff a person would open rather than to be a limit worth
 * tuning: the patch is already held in memory as a string by the time it is parsed, so the
 * cap that matters is the machine's, and a cap here only decides whether the failure is
 * legible. Anything larger fails with a message that names the command.
 */
export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * Builds a runner that invokes `binary` via `execFileSync`, converting a failure into a
 * `VcsError`. `cwd` is optional: git.ts needs it (its tests run against scratch
 * repositories), the gh-backed callers in github.ts and mutate.ts never pass one.
 */
export function execRunner(binary: string, cwd?: string): (args: string[]) => string {
  return (args: string[]) =>
    asVcsError(binary, args, () =>
      execFileSync(binary, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: MAX_OUTPUT_BYTES,
      }),
    );
}
