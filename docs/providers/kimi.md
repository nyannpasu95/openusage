# Kimi Code

> Reverse-engineered, undocumented API. May change without notice.

## Overview

- **Protocol:** REST (plain JSON)
- **Base URL:** `https://api.kimi.com/coding/v1`
- **Auth provider:** `https://auth.kimi.com` (OAuth 2.0)
- **Client ID:** `17e5f671-d194-4dfb-9706-5516cb48c098`
- **Token store:** `~/.kimi-code/credentials/kimi-code.json`

## Endpoints

### GET /usages

Returns overall usage and at least one windowed quota. May also include the
membership monthly total (`totalQuota`) and, when Extra Usage is enabled, the
booster wallet (`boosterWallet`) with its monthly charge limit.

#### Headers

| Header | Required | Value |
|---|---|---|
| Authorization | yes | `Bearer <access_token>` |
| Accept | yes | `application/json` |

#### Example Response

```jsonc
{
  "usage": {
    "limit": "100",
    "remaining": "74",
    "resetTime": "2026-02-11T17:32:50.757941Z"
  },
  "limits": [
    {
      "window": {
        "duration": 300,
        "timeUnit": "TIME_UNIT_MINUTE"
      },
      "detail": {
        "limit": "100",
        "remaining": "85",
        "resetTime": "2026-02-07T12:32:50.757941Z"
      }
    }
  ],
  "totalQuota": {}, // membership monthly total; populated only for some plans
  "boosterWallet": { // only present when Extra Usage is enabled
    "balance": { "type": "BOOSTER", "amount": "2500000000", "amountLeft": "1000000000" },
    "monthlyChargeLimitEnabled": true,
    "monthlyChargeLimit": { "priceInCents": "5000", "currency": "CNY" },
    "monthlyUsed": { "priceInCents": "1250", "currency": "CNY" }
  },
  "user": {
    "membership": {
      "level": "LEVEL_INTERMEDIATE"
    }
  }
}
```

The plugin renders:

- **Session** — smallest window in `limits[]` (the 5-hour rate window)
- **Weekly** — `usage` block (7-day cycle), or the largest window in `limits[]`
- **Monthly** — `totalQuota`, when the API populates it; otherwise falls back to
  the manual override file (see below)
- **Extra Usage** — percent of the `boosterWallet` monthly charge limit used,
  when Extra Usage is enabled and a monthly cap is set
- **Balance** — remaining `boosterWallet` balance (`balance.amountLeft`,
  fixed-point: divide by 1e6 for cents), formatted with the wallet currency

## Temporary Monthly Override

The membership monthly total is not available via the coding API (see Notes), so
as a **temporary** stopgap the plugin reads an optional local file:

`~/.openusage/kimi-monthly.json`

```jsonc
{
  "usedPercent": 92.6,                    // required, 0-100
  "resetsAt": "2026-08-17T00:00:00Z"      // optional, ISO time
}
```

- Values come from the kimi.com subscription page (`subscriptionBalance.amountUsedRatio`
  in `GetSubscriptionStats`).
- When `/usages` starts returning a populated `totalQuota`, the API data wins and
  the file is ignored — delete the file (and this fallback) once that happens.
- Update the file monthly (or delete it to hide the Monthly line).
- Invalid JSON or `usedPercent` outside 0-100 is ignored with a log warning.

### POST https://auth.kimi.com/api/oauth/token

Refreshes `access_token` using `refresh_token`.

#### Request

`application/x-www-form-urlencoded`

```text
client_id=17e5f671-d194-4dfb-9706-5516cb48c098
grant_type=refresh_token
refresh_token=<refresh_token>
```

#### Response

```json
{
  "access_token": "<new_access_token>",
  "refresh_token": "<new_refresh_token>",
  "expires_in": 3600,
  "scope": "kimi-code",
  "token_type": "Bearer"
}
```

## Authentication File

`~/.kimi-code/credentials/kimi-code.json`

```jsonc
{
  "access_token": "<token>",
  "refresh_token": "<token>",
  "expires_at": 1769861835.261056,
  "scope": "kimi-code",
  "token_type": "Bearer"
}
```

## Notes

- The plugin refreshes tokens when near expiry (5-minute buffer).
- If refresh is rejected (401/403), user must run `kimi login` again.
- `limits[0].window.duration=300` and `TIME_UNIT_MINUTE` maps to the 5-hour session window.
- `totalQuota` is always present but currently always `{}` (verified 2026-07 with an
  Intermediate plan). The membership monthly total lives behind
  `POST https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats`
  (used by the kimi.com subscription page), which requires the **web cookie session** —
  the coding OAuth token gets `401 unauthenticated` there, so the plugin cannot read it.
  `GetSubscriptionStats` returns `subscriptionBalance.amountUsedRatio` (monthly total),
  `kimiCodeUsedRatio`, `ratelimitCode5h/7d`, and `boosterWallets[]`.
- `boosterWallet` appears in `/usages` only when the Extra Usage toggle is on
  (`STATUS_DISABLED` wallets are omitted).
