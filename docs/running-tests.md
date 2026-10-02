# Run and recover a failover exercise

Start with the [local demo](../README.md#try-it) if this is your first time using the harness. Run the commands below from the repository root.

## Command output

For a direct command, use `npm start -- <command>`. For machine-readable output, use `npm run --silent start -- demo --json`. Commands default to JSON when output is piped; `--human` overrides that. Successful JSON output goes to stdout. Errors are single-line JSON objects on stderr, which may also contain Node runtime warnings.

## Connect your participants

Live testing requires two prepared participants hosting the same external party. Setup can discover identifiers and validate access, but operators still need to supply the network and identity prerequisites.

1. Upload the bundled `contracts/artifacts/canton-failover-receipts-0.1.0.dar` to both participants using your approved operator workflow. You do not need to compile Daml to use the harness. The package ID and checksum are in [the contract guide](../contracts/README.md).
2. Follow [external-party setup](external-party-setup.md): one party ID, both participants as confirming hosts, confirmation threshold one, and ledger-user rights on each. Obtain the dedicated test party's signing key and endpoint authentication credentials.
3. Put credentials in your shell/secret manager, or copy `.env.example` to a private `.env` file. Files are loaded only when explicitly selected with `--env-file`; setup asks for variable names, never secret values.
4. Run `npm start -- setup --env-file .env`. The wizard supports Keycloak, Okta, Auth0, generic OIDC, and static tokens. It discovers participant IDs and synchronizers through authenticated reads, derives the signing fingerprint locally when possible, and provides manual fallback. Choose baseline for the first connectivity exercise, or failover to test outage acceptance.
5. Run the saved profile through doctor and start:

```sh
npm start -- doctor --profile testnet --env-file .env
npm start -- start --profile testnet --env-file .env
```

Replace `testnet` with the name you chose. Profiles are saved in `profiles/` relative to your working directory, with owner-only permissions on Unix. They contain environment variable references, not credentials. Existing profiles are never overwritten; edit their JSON or create a new name. Use `--config /path/to/config.json` for a config stored elsewhere. `config.example.json` remains available for noninteractive setup.

`doctor` lists independent prerequisite failures together, including missing variables, signing fingerprint, participant identity, synchronizer connectivity, package registration, complete active-contract reads, and the bundled DAR checksum. A failed A check does not suppress B's results. It only acquires auth tokens and reads ledger state. It labels topology as operator-attested and independent writes as untested. Readiness is not proof of failover readiness under an outage.

Set `topologyConfirmed` only after the operator checks are complete. The wizard defaults this attestation to false. For Devnet, keep `mode: "testnet"`; endpoint URLs select the network. The signing key format is the Wallet SDK's base64-encoded 64-byte Ed25519 secret key. No Blockdaemon Wallet service is needed. See [authentication](authentication.md) for provider configuration.

## Run and recover

`start` runs doctor, creates a fresh run directory, initializes one ledger root, and submits the configured workload. Live `start`, `init`, `run`, and `resume` submit signed transactions. The wizard defaults to 30 sequential operations at two-second intervals; confirmation and failover add time. This is not a throughput benchmark.

In an interactive terminal, progress shows the active participant, committed and unresolved operations, acceptance status, and fresh survivor confirmations. For a failover scenario:

1. Wait for root confirmation, then introduce the approved infrastructure fault outside this tool.
2. Type `s` and Enter once the fault is active. Keep the participant unavailable while the survivor completes the required fresh operations.
3. When the requirement is reached, type `e` and Enter before starting restoration.
4. Restore the participant through your operator procedure. Both participants must agree before the run passes.

Type `status` for progress or `q` to stop safely. Ctrl+C also stops after the current bounded request, preserves uncertain outcomes, and exports a report. Hard process termination or power loss cannot export immediately; use `report` or `resume` with the preserved journal afterward.

Every completed, failed, or gracefully interrupted initialized run exports `report.json` and `operations.csv` beside its journal (override with `--out`). Incomplete runs print an exact resume command, including an explicitly selected env-file path. `resume` reuses the saved config path when available; credentials still need to be supplied again through the environment or `--env-file`.

```sh
npm start -- resume --journal ./runs/YOUR-RUN/journal.sqlite --env-file .env
npm start -- report --journal ./runs/YOUR-RUN/journal.sqlite
```

The menu lists saved live runs in the current directory's `runs/`. Simulation endpoints are temporary, so demos are restarted fresh. `resume --primary B` starts on B. Automatic switching is sticky; recovery of A alone does not switch traffic back. The local lock prevents two runners from driving the same journal.

For automation or separate terminals, the original commands remain available:

```sh
npm start -- init --config ./testnet.json --journal ./runs/testnet-001/journal.sqlite
npm start -- run --config ./testnet.json --journal ./runs/testnet-001/journal.sqlite
npm start -- mark --journal ./runs/testnet-001/journal.sqlite --label fault-start --endpoint A
npm start -- mark --journal ./runs/testnet-001/journal.sqlite --label fault-end --endpoint A
```

Record `fault-start` after introducing the fault and `fault-end` before restoration. The harness also requires an observed availability error inside that interval. Markers are operator attestations, not automatic verification of an infrastructure shutdown. Restore both participants before the convergence deadline for a complete verdict. An ambiguous `init` must be resumed with its original journal; never create a new root to clear an error. `preflight` is an alias for `doctor`.

## Start and control a live test from the dashboard

Start the dashboard without configuration flags:

```sh
npm run ui
```

Open `http://127.0.0.1:8787` and click **Live test**. Enter the participant URLs and IDs, shared external party and synchronizer IDs, and authentication details. Bearer tokens, OIDC, and Auth0 client credentials are supported. Enter a signing key to derive its fingerprint automatically, or supply the fingerprint when the key is already in the server environment. Choose the participant to block and the workload size, then confirm that shared-party hosting, independent submission, the test package, and permissions are ready.

Click **Prepare live test** to save connection settings locally and enable live controls. Preparation makes no ledger writes. The dashboard stores non-secret settings and a journal under `runs/`; entered credentials stay only in server memory and are cleared from the form after setup. Credentials are never returned in dashboard responses or written to saved configs. If credentials are already in the server environment, leave their fields blank. Environment references are `CANTON_TEST_SIGNING_KEY`, `CANTON_A_TOKEN` / `CANTON_B_TOKEN` for bearer tokens, or `CANTON_A_CLIENT_SECRET` / `CANTON_B_CLIENT_SECRET` for client credentials.

Click **Check connections** for authenticated prerequisite reads. Failed checks appear in the dashboard with corrective actions. Click **Live setup** to update credentials. Saved run settings are locked so a resumed run preserves its identity and workload contract.

Click **Start live test** to check prerequisites, initialize one ledger root, and submit the configured workload. This button writes signed transactions to the real participants. The UI runs the existing CLI and routes Ledger API requests through its local fault proxy automatically.

While operations are running, click **Block traffic to A** (or the configured B target). Wait for the fresh survivor confirmation requirement, then click **Restore traffic**. The UI records the outage markers. **Stop workload** interrupts the harness and preserves the journal; it does not stop participant infrastructure. **Resume live test** continues that same journal, including reconciliation of unknown initialization or transaction outcomes.

After restarting the dashboard, click **Live test**, select the saved run, re-enter any credentials that were supplied through the form, and click **Prepare live test**, then **Resume live test**. An open proxy outage remains blocked until restored. An unfinished live run cannot be replaced through setup while selected. For another exercise after completion, choose **New test** to get a fresh journal. Reports use the normal CLI report directory beside the journal.

Existing file-based launch commands remain available:

```sh
npm run ui -- --live-config /absolute/path/to/testnet.json --journal /absolute/path/to/run/journal.sqlite --env-file /absolute/path/to/.env
```

Add `--port 8788` if another viewer is already running. This launch uses the server-selected configuration; browser setup is disabled for that viewer.

## Client proxy exercise

Use this exercise when you can submit the dedicated test workload but cannot stop participant infrastructure. The proxy binds to loopback and forwards requests to the two configured Ledger API endpoints. Blocking a route destroys its existing connections and disconnects new requests. Authentication token acquisition still connects directly to your identity provider. The proxy does not retry submissions or store request bodies.

Use a prepared failover config with `primary` matching `scenario.faultedEndpoint`. The commands below use A as the fault target. Run them from the repository root, replacing the absolute config, env-file, and journal paths. Use a fresh journal path for a new exercise.

1. Initialize the test root with both participants reachable:

   ```sh
   npm start -- init --config /absolute/path/to/testnet.json --journal /absolute/path/to/run/journal.sqlite --env-file /absolute/path/to/.env
   ```

   Continue after root confirmation. If initialization is ambiguous, reconcile with `resume` using this same journal. Never initialize another root to clear the error.

2. Start the proxy UI in a separate terminal:

   ```sh
   npm run ui -- --proxy-config /absolute/path/to/testnet.json --journal /absolute/path/to/run/journal.sqlite
   ```

   Open `http://127.0.0.1:8787`. The terminal prints an absolute **Proxy config** path. Keep this process running throughout the exercise.

3. Run the workload through that generated config in your workload terminal:

   ```sh
   npm start -- resume --config /absolute/path/printed/by/proxy/proxy-config-ID.json --journal /absolute/path/to/run/journal.sqlite --env-file /absolute/path/to/.env
   ```

   The generated config preserves participant IDs, external party identity, and environment variable references while routing Ledger API requests through the local proxy. Requests using the original config bypass the proxy and cannot be blocked from this UI.

4. Click **Block traffic to A** while operations are still running. The UI cuts A's connections and records a client-proxy fault-start marker. Wait for the displayed fresh survivor confirmation requirement. Receipt discovery for an earlier A submission does not count toward that requirement.

5. Click **Restore traffic to A**. The UI records fault-end before reopening the route. The harness requires agreement from both participants to finish. It stays on B after recovery.

Do not use the CLI's `s`/`e` or `mark` commands for the same proxy window; the UI manages both markers. Only the configured fault endpoint can be blocked, and each journal accepts one outage window. To test the reverse direction, create a fresh run with B as both primary and fault target.

The report's `faultSource` is `client-proxy`. A successful live exercise reports `CLIENT_PROXY_FAILOVER_PASS`; the equivalent simulator exercise reports `SIMULATION_CLIENT_PROXY_FAILOVER_PASS`. These results demonstrate harness recovery from injected connection loss. They do not establish recovery after participant infrastructure shutdown, loss of synchronization, or topology changes.

If the proxy process stops, both generated routes become unreachable. Preserve the journal. Restart the proxy UI using the original upstream config and the same journal, then resume using the newly printed proxy config. An open client-proxy outage window is reblocked on startup and can be restored through the UI. Do not use an old proxy-generated config as `--proxy-config`: its upstream addresses belong to the previous process.

## The three pieces

| Piece | Location | Behavior |
| --- | --- | --- |
| CLI | Laptop or separate server | Signs test transactions, chooses A or B, reconciles uncertain outcomes, resumes after restart, and exports results. |
| Receipt contract | Canton ledger | A consuming `Advance` choice creates one receipt and the next state atomically. Competing attempts consume the same input state, so only one can succeed. |
| Journal | SQLite beside the CLI | Saves operation intent before submission, marks attempts unknown before execute, and records confirmation only after reading matching ledger evidence. |

The journal is essential recovery state. Keep the SQLite database with its `-wal` and `-shm` companions while the process is running. For a file copy, stop the runner and close its database first. Do not delete the journal to clear an error.

## Recovery rules

1. Persist the intended sequence, payload digest, and exact input contract before submitting. Persist a submission attempt before sending execute.
2. After a timeout, lost response, or restart, inspect ledger receipts. A timeout does not mean failure, and an empty or lagging read does not prove that the submission failed.
3. If retrying is necessary, re-prepare the same logical operation against the same input contract. Cross-participant command deduplication is not assumed. The consuming contract is the duplicate-transition guard.
4. Proceed to the next sequence only after matching the receipt against the persisted intent. Require both participants to agree on the complete receipt chain and final state before a pass.

If receipt progress stalls for `max(pollMs, retryAfterMs)`, the runner checks the other participant before retrying. Successful stale reads, acknowledgements, and contract conflicts do not restart this wait. A validated receipt can resolve an unknown operation without another execution. The runner switches to the other participant when it confirms that operation, or when it exposes the expected input state that the active participant has not reached. Empty or equally stale snapshots do not trigger a switch. Probes remain subject to the operation and run deadlines, and final agreement from both participants is still required.

Root creation cannot use an earlier consuming input. After an ambiguous root submission, the CLI only reconciles; it never submits a second root automatically. If no root can be established, leave the run inconclusive and investigate with the operator. Resume an uncertain `init` with `resume`, not another `init`.

The contract is not a global uniqueness registry for arbitrary owner-created data. A party with signing authority can create extra roots, create receipts outside the intended workflow, or archive contracts. The harness trusts the dedicated signer and validates a pinned root, expected payloads, journal intents, receipt links, and one active state. It fails on inconsistencies it observes. Do not run another application with the test key or reuse a journal for a different workload.

## Results and limits

The example config selects a failover exercise against A:

```json
"scenario": {
  "type": "failover",
  "faultedEndpoint": "A",
  "minSurvivorOperations": 1,
  "recoveryTimeoutMs": 60000
}
```

Choose the recovery limit before initializing the run. The example's 60 seconds is an illustrative acceptance limit, not a measured recovery guarantee. Start on the participant you intend to fault; for the reverse exercise, set both `primary` and `scenario.faultedEndpoint` to `"B"`. For a healthy baseline, use `"scenario": {"type": "baseline"}`. Older configs and journals without a scenario remain baseline runs. The scenario, operation requirement, and recovery limit cannot be changed when resuming a journal.

Failover acceptance requires one closed outage window for the configured endpoint. After an availability error from that endpoint, the survivor must submit and confirm at least `minSurvivorOperations` new operations before the window closes. Every submission attempt for each qualifying operation must be through the survivor inside that window. Finding a receipt for an earlier or faulted-endpoint submission does not count. The first qualifying confirmation must occur within `recoveryTimeoutMs` of `fault-start`, and both participants must converge at the end.

Reports and CLI summaries expose `scenario` and `acceptanceResult`. Successful baseline or infrastructure-fault real-ledger acceptance is labelled `BASELINE_PASS` or `FAILOVER_PASS`; simulation labels are `SIMULATION_BASELINE_PASS` and `SIMULATION_FAILOVER_PASS`. Client-proxy exercises add `CLIENT_PROXY_` before `FAILOVER_PASS`, retaining the `SIMULATION_` prefix for simulator runs. A healthy baseline cannot earn a failover acceptance label.

| Result | Meaning |
| --- | --- |
| `PASS` | The real-ledger workload converged and the configured baseline or failover acceptance checks passed. Read `acceptanceResult` for the kind of test. |
| `SIMULATION_PASS` | The same harness checks passed against the local simulation. This does not validate Canton topology, consensus, authentication configuration, or network recovery. |
| `FAIL` | An observed integrity mismatch, or a closed failover window that missed its acceptance criteria. |
| `INCONCLUSIVE` | A missing prerequisite, unresolved outcome, deadline, auth problem, or unavailable participant prevented a complete verdict. |

Reports contain operation identities, submission attempts, endpoint errors by category, failover events, operator markers, and client confirmation timestamps. The acceptance evidence includes qualifying operations and the observed recovery interval. Missing or unclosed outage markers remain inconclusive. The largest gap between confirmations includes workload intervals. Neither that gap nor the acceptance recovery interval is an exact ledger commit latency, a production RTO, or an RPO-zero guarantee. A completed workload without final two-participant agreement remains inconclusive.

Exit codes are `0` for a completed command, `1` for failed acceptance, configuration/auth/permission, or other non-availability errors, `2` for unresolved availability, and `3` for integrity failures. `report` exports the stored verdict and exits successfully even if that verdict is inconclusive or failed. Read the result and acceptance fields when automating report consumption.

The current CLI is a single writer on one local machine. Durable local intent survives process restart, not loss of that machine or disk. A production service would need a replicated journal, fenced ownership, managed signing, deployment supervision, and operational monitoring. That is a separate architecture scope.
