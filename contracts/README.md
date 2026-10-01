# Canton failover receipt contract

The deployable package contains the `Failover` module. A CLI creates the first `RunState`; the contract does not create one automatically. Each owner-controlled, consuming `Advance` checks the expected sequence and atomically creates a `Receipt` plus the next `RunState`.

`RunState` stores `owner`, `runId`, `nextSequence`, and `previousReceiptId`. `nextSequence` starts at 1. `Receipt` stores `owner`, `runId`, `sequence`, `operationId`, `payloadDigest`, `inputStateId`, and `previousReceiptId`. The operation ID is `runId <> ":" <> show sequence`. `Advance` accepts `sequence` and `payloadDigest` and returns `(ContractId Receipt, ContractId RunState)`.

Use Daml SDK 3.4.11 and Java 17 to build and test from this directory:

```sh
daml build
cd tests
daml test
```

The test package reads the main DAR as a data dependency. Its four Daml Script tests cover a valid transition, a wrong sequence, an unauthorized party, and a second exercise of the consumed state. All four passed with SDK 3.4.11.

Verified deployable DAR: [artifacts/canton-failover-receipts-0.1.0.dar](artifacts/canton-failover-receipts-0.1.0.dar)

- Package ID: `28dfdd1d90c99f39342f781edd003826f37909f5aa061a2aede63a37ba8085eb`
- SHA-256: `1a4ae0b0a1da636a2a0db687437b8bc8748bfe09365cbdaec948c3fd274b5cb9`
- Module and templates: `Failover:RunState`, `Failover:Receipt`

The CLI bundles this verified DAR and checks its checksum during doctor. Upload it through your approved operator workflow. Installing and running the harness does not require the Daml SDK or Java; those are needed only to rebuild or modify the contracts.
