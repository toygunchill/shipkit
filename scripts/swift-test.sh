#!/usr/bin/env bash
# Run the menu-bar package's tests.
#
# `--no-parallel` is not a preference. `ListenerTests` contains a test that
# deliberately saturates the thread pool — `activeProcessorCount + 4`
# simultaneously silent connections, to prove `serve` does not block the
# cooperative pool — and any other socket test running beside it starves, in
# both directions. Measured: in parallel, eight unrelated tests fail with
# timeouts that look like product bugs; serially, all 163 pass in ~13s.
set -euo pipefail
cd "$(dirname "$0")/../apps/menubar"
exec swift test --no-parallel "$@"
