# Canton failover harness

Test whether a workload can continue through either of two Canton participants hosting **the same external party ID**. The CLI submits signed test transactions, reconciles uncertain outcomes, and verifies receipt agreement after recovery.

This is a test tool. Operators control infrastructure faults and prepare participant topology.

[![Architecture: a client signer, runner, and SQLite journal connect to two participants hosting one party on a shared synchronizer](docs/diagrams/architecture.png)](https://cbolden15.github.io/canton-failover-harness/)

[How it works](docs/diagrams/README.md) · [Explore the interactive diagram](https://cbolden15.github.io/canton-failover-harness/)

## Try it

Requires **Node.js 24.10 or newer**.

```sh
git clone https://github.com/cbolden15/canton-failover-harness.git
cd canton-failover-harness
npm ci
npm start
```

Choose **Try the local demo**. It needs no credentials, validators, or Daml SDK. A successful demo reports `SIMULATION_FAILOVER_PASS` and saves JSON/CSV results under `runs/`. Simulation does not validate your live network.

## Test your participants

First, follow the [live-test guide](docs/running-tests.md#connect-your-participants) to prepare the shared party, permissions, receipt DAR, and credentials. Then configure a profile:

```sh
npm start -- setup --env-file .env
npm start -- doctor --profile testnet --env-file .env
npm start -- start --profile testnet --env-file .env
```

Use the profile name you chose. Environment files load only with `--env-file`; omit it when credentials are already in your environment. Start with a healthy baseline, then follow the [outage and recovery procedure](docs/running-tests.md#run-and-recover).

**Keep your journal.** Resume interrupted or uncertain runs with the same journal; never create another root to clear an error.

## Documentation

| Need | Guide |
| --- | --- |
| Understand the components | [Architecture](docs/diagrams/README.md) |
| Prepare and run a live test | [Setup, outage markers, recovery, and results](docs/running-tests.md) |
| Configure party hosting and access | [External-party setup](docs/external-party-setup.md) · [Authentication](docs/authentication.md) |
| Diagnose unexpected behavior | [Known issues](docs/gotchas.md) · [Engineering notes](docs/engineering.md) |
| Build, package, or contribute | [Development](docs/development.md) · [Contracts](contracts/README.md) · [Verification](docs/verification.md) |
