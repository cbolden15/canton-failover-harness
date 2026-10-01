# Authentication with Keycloak, Okta, or Auth0

Configure `endpoints.A.auth` and `endpoints.B.auth` independently. They may use different providers, clients, audiences, and secrets. The CLI obtains OAuth access tokens from the configured provider and sends them to the participant as bearer tokens. Canton remains responsible for validating tokens and enforcing ledger-user rights.

This is the machine-to-machine client-credentials flow offered by OIDC providers. It does not perform browser login or use ID tokens. The external party's transaction-signing key remains separate from its API authentication credentials.

## Choose a provider

Copy the appropriate JSON object's contents into each endpoint's `auth` field. These files are auth fragments, not full CLI configurations. Change `clientSecretEnv` to `CANTON_B_CLIENT_SECRET` for B when using a separate secret.

| Provider | Example | Provider setup |
| --- | --- | --- |
| Keycloak | [keycloak.json](../examples/auth/keycloak.json) | Enable client authentication and service accounts. Use the realm's token endpoint and the authentication method configured for the client. Configure the token's audience through the realm/client scope mappings required by Canton. |
| Okta | [okta.json](../examples/auth/okta.json) | Use an API Services client with a custom authorization server, an access policy permitting client credentials, and a custom API scope. Configure the Canton audience on that authorization server. |
| Auth0 | [auth0.json](../examples/auth/auth0.json) | Authorize a machine-to-machine application for the Canton API. Set `audience` to that API's identifier and request any required scopes. |

Provider references: [Keycloak service accounts](https://www.keycloak.org/docs/latest/server_admin/#_service_accounts), [Keycloak token endpoints](https://www.keycloak.org/securing-apps/oidc-layers), [Okta client credentials](https://developer.okta.com/docs/guides/implement-grant-type/clientcreds/main/), and [Auth0 client credentials](https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-credentials-flow/call-your-api-using-the-client-credentials-flow).

For Okta, use the custom authorization server for your Canton API rather than the org authorization server used for Okta's own APIs. The example's custom scope must be created in your tenant; it is not a built-in Canton scope. See [Okta authorization server types](https://developer.okta.com/docs/concepts/auth-servers/).

## Generic configuration

```json
{
  "type": "oidc",
  "tokenUrl": "https://identity.example.invalid/oauth/token",
  "clientId": "REPLACE_WITH_CLIENT_ID",
  "clientSecretEnv": "CANTON_A_CLIENT_SECRET",
  "tokenEndpointAuthMethod": "client_secret_basic",
  "scope": "YOUR_CUSTOM_SCOPE"
}
```

`tokenUrl`, `clientId`, and `clientSecretEnv` are required. Use the exact token endpoint published by your provider. Endpoint discovery is not performed automatically. HTTPS is required except for loopback development URLs. Redirects are rejected.

`tokenEndpointAuthMethod` defaults to `client_secret_basic`, which sends form-encoded credentials in the HTTP Basic authorization header. Choose `client_secret_post` if your client registration expects credentials in the form body. The token request is always form-encoded for `type: "oidc"`.

`scope` is an optional space-separated string. `audience` is an optional token-request parameter, typically needed for Auth0. Sending an audience parameter does not configure the provider's token claims; configure those on the server where appropriate. Do not add `openid` merely because the provider supports OIDC: this harness is requesting an API access token without a human login.

Secrets are read from the named environment variable. Inline client secrets are rejected by the config schema. Tokens are cached in memory per endpoint and reacquired before expiry, with concurrent acquisition requests sharing one request. Successful responses must contain a nonempty access token, positive numeric `expires_in`, and a bearer token type.

## Configure Canton and verify access

1. Have the operator configure each participant's trusted issuer, signing-key/JWKS validation, expected audience, and identity-provider/user mapping for the chosen provider. The CLI does not change Canton authentication settings.
2. Provision the corresponding application ledger user and party permissions on each participant. Obtaining a valid token does not itself grant `CanReadAs` or `CanExecuteAs` rights.
3. Inject each endpoint's client secret into its configured environment variable. Keep onboarding administrator credentials separate from workload-user credentials.
4. Run `node dist/cli.js preflight --config runs/devnet.json` using the normal application credentials. Confirm both endpoint checks pass before starting the workload.

Rejected credentials, missing secrets, and malformed token responses stop the run as authentication errors. Token-service network failures, timeouts, and HTTP 5xx responses count as availability failures for the endpoint that needs the token, allowing the runner to switch to the other participant. HTTP 429 is throttling and does not increment the endpoint outage counter. These failures remain bounded by the operation and run deadlines.

A rejected GET token is refreshed once; POST requests are never automatically replayed by the transport. Provider response bodies and secrets are excluded from error messages and journals.

## Compatibility and scope

Existing `type: "auth0"` configurations still work with their original JSON token request. Static bearer tokens remain available through `{"type":"static","tokenEnv":"CANTON_TOKEN"}`; the CLI cannot renew a static token itself.

Other providers can use `type: "oidc"` if they support this client-credentials flow with either supported secret authentication method. Interactive authorization-code/device flows, automatic discovery, private-key JWT client authentication, and mutual TLS are not implemented. If a tenant mandates those methods, obtain a token through its approved external tooling and use the static-token option, or extend the authenticator before testing.

Local HTTP tests verify both credential methods, encoding, optional parameters, caching, expiry, redacted failures, and backward compatibility. Actual Keycloak, Okta, and Auth0 tenant integrations still require live preflight validation.
