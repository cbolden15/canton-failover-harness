# Verified gotchas

## Node 24.10 diagnostic output

Node 24.10 prints an `ExperimentalWarning` when importing `node:sqlite`. Its [SQLite documentation](https://nodejs.org/download/release/v24.10.0/docs/api/sqlite.html) classifies the API as active development. The CLI works, but stderr can contain both this runtime diagnostic and the CLI's single-line JSON error object.

Tests that parsed all stderr as one JSON document failed on Node 24.10 while passing on Node 26.8.1. They now select the JSON error line and assert its fields. Consumers should parse stdout for successful JSON results and identify the JSON error line on stderr for failures. Do not globally suppress warnings to make a test pass.

## IdP throttling test timing

During documentation verification, the full suite's `IdP429` test once expected an execution through A but observed B. All three IdP tests passed immediately when run alone, and a subsequent full run passed all 77 tests. The fixture uses a 5 ms receipt-stall probe interval. If a throttled A read takes that long, the runner can legitimately probe B and select its expected input before retrying A. Thus the test's absolute no-switch assertion is timing-sensitive even when throttling remains correctly classified. This observation does not establish a live-network defect. Keep a future test repair scoped to distinguishing availability-triggered switching from evidence-based receipt-stall switching.
