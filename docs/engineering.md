# Engineering notes

## Observed SDK behavior

Wallet SDK 1.5.3's execute helper hardcodes hashing scheme V2 and derives the signing fingerprint from the party namespace. This harness preserves the hashing version returned by prepare and uses the explicitly configured, locally verified key fingerprint. It sends the resulting execute request through the same bounded authenticated provider. Tests exercise a V3 response with a fingerprint different from the party namespace.

The SDK's active-contract helper can reconstruct state from transaction history. The harness instead reads a complete paginated active-contract snapshot at a fixed participant-local offset. This avoids depending on retained history after pruning. Offsets are never compared across participants. Final agreement compares contract identities and the receipt chain.

SDK errors and response bodies may contain request data. Foreign error objects are not printed. Reports contain local error categories, not tokens, signing material, identity-provider responses, or remote error bodies. A 401 causes one refresh for a GET. POST requests, including execute, are never automatically replayed by the transport.

## Dependency audit

The initial install reported 16 moderate entries tracing to one transitive `uuid` advisory, GHSA-w5hq-g745-h8pq. The affected `@metamask/utils` code uses `uuid.v4` for temporary directory names. A scoped override pins that dependency to 11.1.1, which fixes the advisory while retaining its CommonJS and ESM API. The harness itself uses Node's `crypto.randomUUID`. Re-run `npm audit` as part of future dependency updates; the result is time-dependent.

## Storage and lifecycle

SQLite uses WAL and synchronous FULL. The journal stores intents, attempts, and events separately. A second SQLite connection holds an exclusive transaction on a lock database for the runner's lifetime; the operating system releases it on process death. Marker writes use the main database without acquiring the runner lock.

An operation becomes `unknown` before execute leaves the process. An acknowledged HTTP response is recorded as an attempt result, not a confirmed operation. Only a complete matching receipt snapshot moves the operation to `committed`. Failed preparation before execute may leave an operation planned, which is safe to retry against its pinned input.

Every operation has a deterministic ID (`runId:sequence`) and payload digest. Attempts receive separate random submission IDs. The root is created once; an unknown root outcome is never replayed. Contract consumption, rather than participant-local command deduplication, protects cross-participant retries.

Run deadlines include requests and response bodies. Auth and permission failures stop the run; availability failures count toward switching; rate limits and contract conflicts trigger bounded reconciliation without being classified as node outages. A recovered participant does not automatically reclaim primary status.

Token acquisition uses the same failure distinction. Identity-provider network failures, deadlines, and HTTP 5xx are availability failures for the requesting endpoint; HTTP 429 is throttling. Rejected credentials and malformed token responses remain fatal authentication errors. The transport does not replay writes when token acquisition recovers.

Receipt progress has a separate timer from submission attempts. After `max(pollMs, retryAfterMs)` without progress, the runner probes the alternate participant through the same snapshot and journal validation path before another retry. Repeated stale reads, acknowledgements, or conflicts cannot postpone the probe. Alternate evidence must confirm the current operation or expose its expected input state while the active participant lags before it becomes the sticky active participant. Recoverable probe errors are attributed to the probed endpoint and do not count as outages of the active endpoint. The existing operation and run deadlines still bound reconciliation.

## Failover acceptance evidence

Workload completion and final convergence are necessary for every successful run. A failover scenario additionally requires a closed operator-marked outage window, an observed availability error from the faulted endpoint, and new survivor operations submitted and confirmed inside the window after that error. All attempts for a qualifying operation must be through the survivor inside the window; an earlier ambiguous attempt on A cannot become evidence of B's write availability merely because B later returns its receipt.

Journal event IDs establish order even when markers, dispatches, and confirmations share a millisecond timestamp. Validated receipt confirmations record which endpoint supplied the evidence. Wall-clock timestamps measure the client-observed interval from fault-start to the first qualifying confirmation. These observations depend on the operator accurately delimiting the outage and do not prove that the infrastructure remained shut down throughout it.

The scenario and acceptance limits are persisted at initialization and checked on resume. Missing scenario metadata identifies an older baseline journal. Reports distinguish baseline and failover acceptance, and retain simulation labels. A closed window that misses its operation or recovery requirement fails acceptance; absent or unclosed windows remain inconclusive. Final agreement of both participant snapshots remains mandatory.

## Live acceptance still required

Use a dedicated testnet party and validate the exact deployed API version, compiled DAR compatibility, OIDC issuer/audience/user mappings, required ledger rights, and independent participant confirmation. Run healthy, lost-response, A-down, B-down, client restart, and restored-participant convergence exercises. Preserve journals and reports. A simulator pass does not replace those checks.

## Onboarding verification, 2026-09-30

The UX integration passed 77 automated tests on macOS with Node 26.8.1 and the minimum Node 24.10.0. Typecheck and build passed. The clean-install smoke verified a fresh source copy with `npm ci` and `npm start`; the packaged-install smoke verified the installed executable outside the checkout without dev dependencies, the bundled DAR, and a persisted `SIMULATION_FAILOVER_PASS`.

Interactive terminal checks covered the menu, invalid-choice retry, the local demo, and setup cancellation. Automated checks covered explicit env-file loading, reusable profiles, independent doctor failures, automatic reports, graceful interruption after an ambiguous execute, and resuming without duplicate execution. Open-window progress reports provisional qualifying operations but cannot produce an acceptance pass before closure and final convergence. See [verified gotchas](gotchas.md) for Node 24 diagnostic handling.

GitHub workflows are configured for Ubuntu/macOS and Node 24/26 but have not run remotely. No real participant endpoints, credentials, package uploads, topology changes, or infrastructure faults were used. Daml sources were unchanged in this milestone, so contract tests were not rerun.
