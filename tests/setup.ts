import { join } from "node:path";
import { tmpdir } from "node:os";

// The suite must not care what is running in the user's menu bar.
//
// Without this, `jiraToken()`'s socket fallback and `requestApproval`'s
// default path both reach the developer's own live approval surface, and the
// suite's results change with it: a saved real token turned "no Jira call
// without a token" tests into real network calls, and an e2e run took six
// seconds timing out against the company Jira. Found the honest way — the
// suite went red on one machine and green on another, and the difference was
// whether an app was running.
//
// `defaultSocketPath()` honours this variable, spawned CLIs inherit it, and
// tests that genuinely need a socket create their own and say so explicitly.
process.env.SHIPKIT_APPROVAL_SOCKET = join(
  tmpdir(),
  "shipkit-tests-never-a-surface",
  `${process.pid}.sock`,
);
