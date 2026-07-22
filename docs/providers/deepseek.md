# DeepSeek

> Shows your DeepSeek API account balance and availability. Uses the official balance endpoint with a user-provided API key.

## Overview

- **Protocol:** HTTPS (JSON)
- **Endpoint:** `GET https://api.deepseek.com/user/balance`
- **Auth:** `Authorization: Bearer <api_key>`
- **Window model:** Cash balance (no usage window; balance is a point-in-time total)

DeepSeek's API only exposes account balance via Bearer auth. Per-token or per-model usage breakdowns are **not** available through the API key — those live on the DeepSeek web console under session-cookie auth, which the plugin cannot use. The plugin therefore shows balance, not usage. "Spent Today" is an **approximation** derived from balance snapshots — see [Spent Today approximation](#spent-today-approximation) below.

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
- **Spent Today** (detail text, approximate): how much the balance has dropped since the first refresh of the local day. Omits on the first refresh of a new day (no baseline yet). Same multi-currency formatting as Balance.

Because balance has no defined cap, the plugin does not emit a progress line. When DeepSeek is the selected menubar provider, the menubar title shows the Balance amount instead of a percentage.

## Spent Today approximation

DeepSeek exposes no per-day usage API, so Spent Today is computed from balance snapshots:

```
spent_today ≈ baseline_total_balance − current_total_balance
```

where `baseline` is the total balance seen on the **first refresh of the local day**. Each currency is tracked independently.

Limitations of this method:

- **Only app-running time counts.** If the app is closed for part of the day, any spend during that window is missed — the baseline is whatever the app first sees that day.
- **Top-ups are compensated.** A rising `topped_up_balance` within the same day is treated as a recharge and raises the baseline by the same amount, so it is not counted as negative spend.
- **Granted-balance expiry is miscounted.** DeepSeek's API does not distinguish a granted-credit expiry from real consumption, so an expiring granted balance shows up as apparent spend. The plugin does not try to correct this.
- **Small upward drift is clamped to 0** so transient noise never appears as negative spend.
- **First refresh of a new day shows nothing** (no baseline yet); from the second refresh onward the value appears.

State is stored in `pluginDataDir/spent-today.json` and can be deleted to reset the baseline.

## Errors

| Condition | Message |
|---|---|
| Missing API key | `DeepSeek API key missing. Set DEEPSEEK_API_KEY.` |
| HTTP 401/403 | `API key invalid. Check your DeepSeek API key.` |
| Non-2xx | `Balance request failed (HTTP {status}). Try again later.` |
| Network failure | `Balance request failed. Check your connection.` |
| Unparseable payload | `Balance response invalid. Try again later.` |
| No balance data | `Could not parse balance data.` |
