# Compatibility, packaging, and development

For installation and the local demo, see the [quick start](../README.md#try-it). Run the commands below from the repository root.

## Compatibility and verification

The adapter is pinned to `@canton-network/wallet-sdk` 1.5.3. It uses the SDK for key handling and preparation, with explicit HTTP transport for deadlines, provider-neutral authentication, complete snapshots, and execution. Required routes include `/v2/authenticated-user`, `/v2/parties/participant-id`, `/v2/state/connected-synchronizers`, `/v2/packages/{packageId}/status`, `/v2/state/ledger-end`, `/v2/state/active-contracts-page`, and `/v2/interactive-submission/{prepare,executeAndWait}`.

The response shapes are based on the SDK's packaged Ledger API 3.5/3.6 types. Actual deployment compatibility must be checked before the live exercise. Unsupported or incomplete snapshots fail closed. The local protocol simulator intentionally does not implement a full Canton participant or signature authorization engine.

`npm test` covers lost replies, pagination, failover, competing submissions, persisted unknown outcomes, a real process kill/restart, ambiguous root creation, topology attestation, journal locking, auth refresh, error classification, and bounded waits. Daml tests separately exercise the contract. See [engineering notes](engineering.md) for implementation caveats and the final verification record.

## Install a packaged release

This project is not published to npm yet. A maintainer can prepare a versioned tarball and `SHA256SUMS` with:

```sh
npm run release:prepare
```

After obtaining a verified tarball, install its named executable without a source build or Daml toolchain:

```sh
npm install --global ./canton-failover-0.1.0.tgz
canton-failover
```

A source checkout can also use `npm link` after `npm run build`. Run the installed command from the directory where you want your profiles and journals. The packaged CLI includes the compiled runtime and verified DAR. Profiles, `.env` files, run databases, and local development data are excluded.

## Develop and verify

```sh
npm run check
npm test
npm run build
npm run smoke:clean
npm run smoke:release
```

The clean-install smoke copies an allowlisted fresh checkout, runs `npm ci`, and starts the demo. The release smoke packs the project, installs it without dev dependencies outside the checkout, and verifies the named executable, version, bundled DAR, and simulated failover report.

GitHub Actions runs these checks on Ubuntu and macOS with Node 24 and 26. The release workflow creates a tarball and checksum artifact on version tags or manual dispatch; it does not publish to npm or create a public GitHub Release. Windows is not currently in the tested matrix. Contract changes additionally require the Daml checks in [the contract guide](../contracts/README.md).
