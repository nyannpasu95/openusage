# DeepSeek

> Shows your DeepSeek API account balance and availability. Uses the official balance endpoint with a user-provided API key.

## Overview

- **Protocol:** HTTPS (JSON)
- **Endpoint:** `GET https://api.deepseek.com/user/balance`
- **Auth:** `Authorization: Bearer <api_key>`
- **Window model:** Cash balance (no usage window; balance is a point-in-time total)

DeepSeek's API only exposes account balance via Bearer auth. Per-token or per-model usage breakdowns are **not** available through the API key — those live on the DeepSeek web console under session-cookie auth, which the plugin cannot use. The plugin therefore shows balance, not usage.

## Authentication

Reads `DEEPSEEK_API_KEY` from the environment. If missing or empty, the plugin throws:

- `DeepSeek API key missing. Set DEEPSEEK_API_KEY.`

## Data Source

Request:

```http
GET /user/balance HTTP/1.1
Host: api.deepseek.com
Authorization: Bearer <api_key>
Accept: application/json
```

Response fields:

- `is_available` (boolean) — whether the balance is sufficient for API calls
- `balance_infos[]`
  - `currency` (`CNY` or `USD`)
  - `total_balance` (string)
  - `granted_balance` (string) — promotional balance that may expire
  - `topped_up_balance` (string) — paid balance that does not expire

When multiple `balance_infos` entries are present, non-zero currency entries are shown. If every entry is zero for a field, all available currencies are shown.

## Output

- **Status** (overview badge): `Available` (green) when `is_available` is true, otherwise `Insufficient` (red)
- **Balance** (overview text): total balance with currency symbol and code, e.g. `¥8.66 CNY`, `$12.34 USD`, or `$5.00 USD + ¥9.99 CNY`
- **Granted** (detail text): granted balance, same formatting
- **Topped Up** (detail text): topped-up balance, same formatting

Because balance has no defined cap, the plugin does not emit a progress line. When DeepSeek is the selected menubar provider, the menubar title shows the Balance amount instead of a percentage.

## Errors

| Condition | Message |
|---|---|
| Missing API key | `DeepSeek API key missing. Set DEEPSEEK_API_KEY.` |
| HTTP 401/403 | `API key invalid. Check your DeepSeek API key.` |
| Non-2xx | `Balance request failed (HTTP {status}). Try again later.` |
| Network failure | `Balance request failed. Check your connection.` |
| Unparseable payload | `Balance response invalid. Try again later.` |
| No balance data | `Could not parse balance data.` |
