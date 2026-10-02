# Verified gotchas

## Dashboard connector sizing

Keep the connector SVG absolutely positioned inside its grid cell. An SVG with percentage width/height in normal grid flow can contribute its `viewBox` aspect ratio to the row's intrinsic height. Updating that viewBox from a ResizeObserver then creates sizing feedback after viewport changes, expanding the routing panel during polling.

The participant cards now determine the row height, and the SVG fills that row without contributing intrinsic size. Browser checks at 320 px, 390 px, and desktop widths verified the route layout and the transition back to desktop.

## Node 24.10 diagnostic output

Node 24.10 prints an `ExperimentalWarning` when importing `node:sqlite`. Its [SQLite documentation](https://nodejs.org/download/release/v24.10.0/docs/api/sqlite.html) classifies the API as active development. The CLI works, but stderr can contain both this runtime diagnostic and the CLI's single-line JSON error object.

Tests that parsed all stderr as one JSON document failed on Node 24.10 while passing on Node 26.8.1. They now select the JSON error line and assert its fields. Consumers should parse stdout for successful JSON results and identify the JSON error line on stderr for failures. Do not globally suppress warnings to make a test pass.

## IdP throttling test timing

During documentation verification, the full suite's `IdP429` test once expected an execution through A but observed B. All three IdP tests passed immediately when run alone, and a subsequent full run passed all 77 tests. The fixture uses a 5 ms receipt-stall probe interval. If a throttled A read takes that long, the runner can legitimately probe B and select its expected input before retrying A. Thus the test's absolute no-switch assertion is timing-sensitive even when throttling remains correctly classified. This observation does not establish a live-network defect. Keep a future test repair scoped to distinguishing availability-triggered switching from evidence-based receipt-stall switching.

The same A-versus-B assertion occurred once in the 85-test suite while adding browser live setup. The new UI tests passed, and all three IdP tests passed in isolation. A subsequent full run passed all 85 tests. The receipt-stall timing above also applies to this observation.

## Chrome blocks a previously used local dashboard port

Browser verification twice showed `ERR_BLOCKED_BY_CLIENT` when returning to port 8787 after a dashboard restart, while direct HTTP requests to that server succeeded. Opening the same dashboard on a fresh local port succeeded, including the setup controls. The cause of the Chrome blocking was not established. Check server reachability before treating this as an application failure; a fresh port can provide a working preview without changing browser security settings.
