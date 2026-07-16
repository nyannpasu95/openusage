# Local HTTP API

OhMyUsage exposes a read-only HTTP API on the loopback interface so other local apps can consume the same usage data shown in the menu bar.

**Base URL:** `http://127.0.0.1:6736`

The server starts automatically with the app. If the token cannot be stored securely or the server cannot bind to its loopback port, the feature is disabled for that session. Check the **Local HTTP API** section in Settings for the current status.

## Routes

### `GET /v1/usage`

Returns an array of cached usage snapshots for all **enabled** providers, ordered by your plugin settings.

- **200 OK** — JSON array (may be empty `[]` if no cached data exists yet).

### `GET /v1/usage/:providerId`

Returns a single cached usage snapshot for the given provider.

- **200 OK** — JSON object with cached snapshot.
- **204 No Content** — Provider is known but has no cached snapshot yet.
- **404 Not Found** — Provider ID is unknown.

### Unsupported methods

Any method other than `GET` or `OPTIONS` on the above routes returns **405 Method Not Allowed**.

Unknown routes return **404 Not Found**.

## Response Shape

```json
{
  "providerId": "claude",
  "displayName": "Claude",
  "plan": "Team 5x",
  "lines": [
    {
      "type": "progress",
      "label": "Session",
      "used": 42.0,
      "limit": 100.0,
      "format": { "kind": "percent" },
      "resetsAt": "2026-03-26T13:00:00.161Z",
      "periodDurationMs": 18000000,
      "color": null
    },
    {
      "type": "text",
      "label": "Today",
      "value": "$5.17 \u00b7 9.2M tokens",
      "color": null,
      "subtitle": null
    },
    {
      "type": "barChart",
      "label": "Usage Trend",
      "points": [
        { "label": "3/25", "value": 1200000.0, "valueLabel": "1.2M tokens" },
        { "label": "3/26", "value": 2400000.0, "valueLabel": "2.4M tokens" }
      ],
      "note": "Estimated from local logs",
      "color": null
    }
  ],
  "fetchedAt": "2026-03-26T11:16:29Z"
}
```

The `lines` array uses the same metric line types as the internal plugin output: `progress`, `text`, `badge`, and `barChart`.

`fetchedAt` is an ISO 8601 timestamp indicating when the snapshot was last successfully fetched.

`iconUrl` is intentionally omitted from the API response to keep payloads small.

## Filtering and Caching Behavior

- The collection endpoint (`/v1/usage`) returns **enabled providers only**, in the order defined by your plugin settings.
- Only **successful** probe results are cached. A failed probe never overwrites a previous successful snapshot.
- The single-provider endpoint (`/v1/usage/:providerId`) works for any known provider, including disabled ones.

## Authentication

All `GET` requests require a bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

The token is generated randomly on each app launch and written to a file named `local-api-token` in the app data directory. On Unix systems, the file is restricted to the current user (`0600`). The API does not start if this file cannot be written securely. Read this file to obtain the token. The token file path is shown in the **Local HTTP API** section of Settings.

Requests without a valid token receive **401 Unauthorized**.

`OPTIONS` (preflight) requests do not require authentication.

## CORS

CORS is restricted to loopback origins only (`http://localhost`, `http://127.0.0.1`, `http://[::1]` on any port). External origins are rejected with `Access-Control-Allow-Origin: null`.

```
Access-Control-Allow-Origin: <reflected loopback origin>
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
```

`OPTIONS` requests return **204 No Content** with these headers for preflight support.

## Error Responses

Error responses use this shape:

```json
{
  "error": "provider_not_found"
}
```

Possible error codes: `provider_not_found`, `not_found`, `method_not_allowed`, `unauthorized`, `server_busy`.

`unauthorized` returns **401 Unauthorized** when the bearer token is missing or incorrect.

`server_busy` returns **503 Service Unavailable** when the local API is already handling the maximum number of concurrent connections. Clients should back off and retry later.
