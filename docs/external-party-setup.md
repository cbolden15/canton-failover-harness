# Create an external party on both validators

For this failover test, create one external party identity and establish its hosting relationship on validator A and validator B. Both must report the same party ID. Creating an unrelated party on each validator would produce two separate workloads.

This runbook is for a fresh test party with no existing contracts. Adding a host to an existing party requires the operator's party-replication procedure instead. The commands below change topology only when you run the allocation step. They have not been run against your Devnet.

Choose a provider using [Authentication setup](authentication.md); the same settings work for the onboarding transport and the workload CLI.

## 1. Prepare access to both participants

Run these examples from the project root after `npm ci` and `npm run build`. They use the project's authenticated transport and installed Wallet SDK 1.5.3. The request fields were checked against its Ledger API 3.5.10 types; confirm your deployed version supports these routes before proceeding.

Copy `config.example.json` to `runs/onboarding/admin.json`. Fill in the two JSON Ledger API URLs, their participant IDs, the shared synchronizer ID, and OIDC client-credentials settings for an operator authorized to allocate external parties. Keep the placeholder party/fingerprint for now and `topologyConfirmed: false`. Supply the referenced client-secret environment variables through your usual secret manager. Keep this operator configuration separate from the eventual application-user configuration.

```sh
mkdir -p runs/onboarding
chmod 700 runs/onboarding
cp config.example.json runs/onboarding/admin.json
chmod 600 runs/onboarding/admin.json
```

Both participants need permission to connect to the same synchronizer and must accept external-party hosting. Obtain the identity-provider ID applicable to the new party on each participant; the examples omit it and therefore use the default identity provider. If your deployment uses a non-default provider, add its participant-specific `identityProviderId` to each allocation request. OIDC authentication alone does not grant Canton administrative rights.

## 2. Generate one dedicated signing key

Generate the key once on the CLI machine. This example saves it in the ignored `runs/` directory with owner-only permissions. It does not print the private key or send it to either validator. Preserve it in your secret manager before relying on the party.

```sh
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { SDK, CustomLogAdapter } from '@canton-network/wallet-sdk';
const sdk = SDK.createOffline({ logAdapter: new CustomLogAdapter(() => {}) });
const key = sdk.keys.generate();
writeFileSync('runs/onboarding/key.json', JSON.stringify({
  ...key, fingerprint: await sdk.keys.fingerprint(key.publicKey)
}, null, 2), { mode: 0o600, flag: 'wx' });
console.log('Dedicated key saved; private key was not printed.');
JS
```

`flag: 'wx'` prevents accidentally replacing an existing key. The SDK produces the base64 64-byte Ed25519 private-key format used by this CLI. Use this same key for onboarding and the test workload; do not generate a new key for B.

## 3. Prepare and sign a topology containing both hosts

This step checks the endpoint identities, asks A to generate a topology containing A and B, and saves the signed allocation request. It does not yet allocate the party. Run it once and retain the generated files for both validator approvals.

```sh
node --input-type=module <<'JS'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { signTransactionHash } from '@canton-network/wallet-sdk';
import { loadConfig } from './dist/model.js';
import { Transport } from './dist/transport.js';
if (existsSync('runs/onboarding/topology.json') || existsSync('runs/onboarding/allocate.json')) {
  throw new Error('Saved topology already exists; inspect and reuse it.');
}
const c = loadConfig('runs/onboarding/admin.json');
const key = JSON.parse(readFileSync('runs/onboarding/key.json', 'utf8'));
const clients = { A: new Transport('A', c), B: new Transport('B', c) };
for (const id of ['A', 'B']) {
  clients[id].deadline = Date.now() + 60000;
  const p = await clients[id].raw('GET', '/v2/parties/participant-id');
  if (p.participantId !== c.endpoints[id].participantId) throw new Error(`Participant ${id} identity mismatch`);
  const s = await clients[id].raw('GET', '/v2/state/connected-synchronizers');
  if (!s.connectedSynchronizers?.some(x => x.synchronizerId === c.synchronizerId)) {
    throw new Error(`Participant ${id} is not connected to the configured synchronizer`);
  }
}
const topology = await clients.A.raw('POST', '/v2/parties/external/generate-topology', {
  synchronizer: c.synchronizerId,
  partyHint: 'failover-devnet',
  publicKey: { format: 'CRYPTO_KEY_FORMAT_RAW', keyData: key.publicKey, keySpec: 'SIGNING_KEY_SPEC_EC_CURVE25519' },
  localParticipantObservationOnly: false,
  otherConfirmingParticipantUids: [c.endpoints.B.participantId],
  observingParticipantUids: [],
  confirmationThreshold: 1
});
if (!topology.partyId || !topology.multiHash || !topology.topologyTransactions?.length || topology.publicKeyFingerprint !== key.fingerprint) {
  throw new Error('Invalid topology response or unexpected signing fingerprint');
}
writeFileSync('runs/onboarding/topology.json', JSON.stringify(topology, null, 2), { mode: 0o600, flag: 'wx' });
const allocation = {
  synchronizer: c.synchronizerId,
  waitForAllocation: false,
  onboardingTransactions: topology.topologyTransactions.map(transaction => ({ transaction })),
  multiHashSignatures: [{
    format: 'SIGNATURE_FORMAT_CONCAT',
    signature: signTransactionHash(topology.multiHash, key.privateKey),
    signedBy: key.fingerprint,
    signingAlgorithmSpec: 'SIGNING_ALGORITHM_SPEC_ED25519'
  }]
};
writeFileSync('runs/onboarding/allocate.json', JSON.stringify(allocation, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ party: topology.partyId, signingFingerprint: key.fingerprint }, null, 2));
JS
```

Have the operator review the generated topology before allocation: A and B should both be confirming hosts, with participant confirmation threshold **1**. An observation-only B cannot replace an unavailable confirming A. Threshold **2** would require both confirming hosts and defeat this particular single-host-outage test. The external signing-key threshold is a separate setting; this harness uses one signing key.

The official [multi-hosted onboarding tutorial](https://docs.digitalasset.com/build/3.5/tutorials/app-dev/external_signing_onboarding_multihosted.html) demonstrates the generate/sign/allocate flow, including allocation on both participants. Its confirming-host example uses threshold two; this runbook deliberately uses one for the failover exercise.

## 4. Allocate the same party on A and B

Run the following block first with `HOST=A`, then again with `HOST=B`. Each call submits the same signed topology to that participant's Ledger API. A successful HTTP response is only an acknowledgement; confirm that the topology becomes authorized after both approvals.

```sh
HOST=A node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { loadConfig } from './dist/model.js';
import { Transport } from './dist/transport.js';
const id = process.env.HOST;
if (!['A', 'B'].includes(id)) throw new Error('HOST must be A or B');
const c = loadConfig('runs/onboarding/admin.json');
const client = new Transport(id, c);
client.deadline = Date.now() + 60000;
const body = JSON.parse(readFileSync('runs/onboarding/allocate.json', 'utf8'));
// For a non-default identity provider, set body.identityProviderId here.
await client.raw('POST', '/v2/parties/external/allocate', body);
console.log(`Allocation request acknowledged by ${id}; verify authorized hosting after both calls.`);
JS
```

If A times out, keep the saved key and topology, inspect the proposal with the operator, and still obtain B's approval for that same proposal. Do not restart key generation or create a different party to work around an uncertain response. Any resubmission must reuse the saved topology after checking its current state.

After both calls, use each participant's `GET /v2/parties/{party}` endpoint to check for the generated `partyId` in `partyDetails`. The operator must also inspect the effective party-to-participant topology: the expected A/B participant IDs, confirming permissions, threshold one, and no pending hosting approval. Listing a party alone does not prove those properties.

## 5. Give the CLI access and verify the setup

Provision the identity-provider-mapped application ledger user separately on each participant. Through the participant's user-management API or your normal operator tooling, grant that user `CanReadAs` and `CanExecuteAs` for the generated party. The installed API types define `CanExecuteAs` as permitting prepare/execute without read rights. `CanActAs` also includes execute permission, but is broader. Use the rights supported by your deployed version. Do not run the workload using the onboarding administrator's credentials.

Copy the normal example config to `runs/devnet.json` and fill in:

| Config field | Value |
| --- | --- |
| `party` | `partyId` from `runs/onboarding/topology.json`, identical for both hosts. |
| `signingFingerprint` | `fingerprint` from `runs/onboarding/key.json`. |
| `signingKeyEnv` | The environment variable containing that file's `privateKey`, injected by your secret manager. |
| `endpoints.A` / `endpoints.B` | Verified participant URLs/IDs and the application users' OIDC client-credentials settings. |
| `topologyConfirmed` | Set to `true` only after the operator verifies effective hosting and independent confirmation. |

Keep `mode: "testnet"` for Devnet with the current CLI schema; the URLs select the network. Set `count: 10` and `scenario: {"type": "baseline"}` for the first healthy run. The example config otherwise selects failover acceptance, which requires outage markers and survivor progress. Upload and vet the supplied receipt DAR on both participants through your operator workflow before preflight.

For a local test shell, load the private key without printing it:

```sh
export CANTON_TEST_SIGNING_KEY="$(node --input-type=module -e "import fs from 'node:fs'; process.stdout.write(JSON.parse(fs.readFileSync('runs/onboarding/key.json','utf8')).privateKey)")"
node dist/cli.js preflight --config runs/devnet.json
node dist/cli.js init --config runs/devnet.json --journal runs/devnet-001/journal.sqlite
node dist/cli.js run --config runs/devnet.json --journal runs/devnet-001/journal.sqlite
```

Use a fresh journal for each new run. After the healthy baseline, configure a failover scenario with the chosen endpoint, survivor-operation count, and recovery limit, then initialize a new journal and follow the README's outage-marker procedure. Preflight verifies reads and configuration; the controlled outage test is what verifies that either host can continue the workload independently.

These examples were checked against the installed SDK and API types and syntax-checked locally. Successful onboarding, OIDC permissions, and topology propagation remain unverified until run against your participants.
