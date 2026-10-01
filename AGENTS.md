# Canton failover

This repository implements a test harness, not a production failover service.

Run `npm run check`, `npm test`, and `npm run build` after changes. Run `daml build` and `daml test` in contracts when modifying Daml.

Preserve logical operation identity and input contract across retries. Never treat missing receipt data or a timed-out execute as a definitive failure. Never create a second run root after ambiguous initialization. SDK transport must not silently retry writes. Do not log tokens, signatures, prepared transactions, or private keys.

Live endpoints and credentials are supplied at integration time. Simulator results must always be labelled simulation. No live DAR upload, party onboarding, topology edits, or infrastructure shutdown without explicit authorization.
