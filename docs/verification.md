# Verification record

Verified locally on September 30, 2026, using Node.js 26.8.1 on macOS arm64.

| Check | Result |
| --- | --- |
| `npm run check` | Passed. |
| `npm test` | 77 tests passed; zero failures or skipped tests. Also passed on Node 24.10.0. |
| `npm run build` | Passed; executable CLI emitted under `dist`. |
| `npm audit --omit=dev` | Zero reported vulnerabilities at verification time. |
| Compiled CLI demo | `SIMULATION_PASS` with `SIMULATION_FAILOVER_PASS` acceptance, 8 committed operations, 1 failover. |
| Main Daml package build | Passed with Daml SDK 3.4.11. |
| Separate Daml Script tests | 4 passed using Java 17. |
| Packaged DAR manifest/hash | Main package ID and SHA-256 match `contracts/README.md` and `config.example.json`. |

The CLI tests include an actual child-process SIGKILL immediately after the simulated ledger commits an operation. A new process/database connection acquires the released lock, reads the persisted unknown intent, reconciles its receipt through participant B, and completes without a second execution of that operation.

The Daml tests verify an authorized state transition, rejection of the wrong sequence, rejection of an unauthorized party, and rejection of a second consumption of the same state. Test scripts are packaged separately from the deployable contract.

`samples/simulation-report.json` and `samples/simulation-operations.csv` come from the final compiled CLI demonstration. They contain synthetic data only.

No real Canton endpoints were configured or used. No DAR was uploaded, no party was onboarded, no topology was changed, and no real-ledger transaction was submitted. Live API compatibility, OIDC provider setup, independent confirmation, and infrastructure failure behavior remain to be verified in the user's testnet environment.

The OIDC update additionally verifies form-encoded Basic and POST client authentication, special-character credential encoding, optional audience/scope parameters, expiry renewal, independent caches, invalid-response redaction, config rejection, and all three provider examples. Existing Auth0 JSON configuration remains covered. Live provider tenants were not contacted.

The recovery and acceptance updates add regressions for stale participant views, alternate reconciliation, temporary identity-provider failures, and explicit outage-window acceptance. Local HTTP tests distinguish network/timeouts/5xx from credential rejection and throttling. An SDK-backed simulation verifies that B continues the same operation after A's token refresh encounters an identity-provider 503.

Acceptance tests reject restored-only progress, pre-window or faulted-endpoint attempts discovered through B, missed recovery limits, and mismatched markers. They also cover equal-millisecond event ordering, persisted scenario limits, legacy baseline journals, and final convergence. A CLI smoke test verifies endpoint-aware markers and report export. Independent review found no actionable issues.

The refreshed compiled demo loses the response to operation 2, reconciles it without another execute, and confirms operations 3 through 8 through B inside the marked outage window. It restores A and verifies convergence before reporting `SIMULATION_FAILOVER_PASS`. The outage window is simulated and operator-marked; this remains local verification only.
