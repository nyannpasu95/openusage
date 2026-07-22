# Qwen Token Plan

> Shows your Qianwen AI platform (platform.qianwenai.com) Token Plan usage. Supports the individual plan (个人版: 5-hour and weekly quota windows) and the teams plan (团队版 credits). Uses the web console's own gateway with a browser cookie.

## Overview

- **Protocol:** HTTPS (form-encoded POST, JSON response)
- **Endpoints:**
  - `POST https://cs-data.qianwenai.com/data/api.json` (individual plan)
  - `POST https://platform-home.qianwenai.com/data/api.json` (teams plan)
  - `GET https://platform-home.qianwenai.com/tool/user/info.json` (session validation + `secToken`)
- **Auth:** `Cookie` header copied from a logged-in platform.qianwenai.com session
- **Window model:** Individual plan = rolling 5-hour + weekly quota windows; teams plan = subscription credit totals

The Token Plan API key (`sk-sp-...`) and the Qianwen CLI access token both only work for model inference and the CLI gateway — neither can query the console's personal-plan APIs (verified against a live account: the CLI gateway returns empty data for the personal namespace, and the console gateway rejects CLI tokens with `ConsoleNeedLogin`). The plugin therefore uses the console session cookie, exactly like the Token Plan web page.

Note: `cs-data.qianwenai.com` sits behind an anti-bot gateway that rejects requests missing the standard Chromium header set (`sec-ch-ua`, `Sec-Fetch-*`, `Accept-Language`, …) with a 302 to `err.taobao.com`. The plugin sends the full header set, mirroring the browser.

## Authentication

Resolved in order:

1. `QWEN_COOKIE` environment variable.
2. The cookie file `~/.openusage/qwen-cookie.txt` (read fresh on every refresh — updating it needs no app restart).

To set it up:

1. Log in at `https://platform.qianwenai.com/home/billing/subscription/token-plan-individual`.
2. Open the browser's developer tools → Network tab.
3. Refresh the page, click any request to `cs-data.qianwenai.com` or `platform-home.qianwenai.com`, and copy the full `Cookie:` request header value.
4. Save it with either method:
   - Easiest: run `pbpaste > ~/.openusage/qwen-cookie.txt` right after copying (creates `~/.openusage` if needed: `mkdir -p ~/.openusage`).
   - Or set it as the `QWEN_COOKIE` environment variable (requires an app restart to pick up changes).

Before querying, the plugin calls `GET /tool/user/info.json` with the cookie to validate the session and resolve `secToken` (sent as the `sec_token` form field; falls back to `0` like the console does).

Cookies expire (the session lasts roughly a month). When the session goes stale the plugin shows `Qianwen console session expired.` — copy a fresh cookie and repeat step 4.

## Data Sources

All calls are form-encoded POSTs to `/data/api.json?product=<p>&action=<a>` with body fields `product`, `action`, `sec_token`, `region`, `language`, `params` (JSON). The plugin tries the individual plan first, then falls back to the teams plan.

### Individual plan (个人版)

On `cs-data.qianwenai.com`: `product=sfm_bailian`, `action=BroadScopeAspnGateway`, `api=<Api>` in the query string; form body `product`, `action`, `sec_token`, `region=cn-beijing`, `params` (JSON). The `params` envelope is `{ Api, Data, V: "1.0" }` where `Data` always carries a `cornerstoneParam` object (`domain`, `consoleSite`, `console`, `xsp_lang`, `protocol`, `productCode`) — the backend returns `Bad Request` without it.

| Api (`zeldaHttp.apikeyMgr.` prefix) | Data fields | Used for |
|---|---|---|
| `/tokenplan/personal/api/v2/subscription` | `commodityCode` | Plan detection, `specCode` (lite/standard/pro), `endTime` (epoch ms) |
| `/tokenplan/personal/api/v2/usage` | — | `per5HourPercentage` / `per1WeekPercentage` (used ratios 0–1), `per5HourResetTime` / `per1WeekResetTime` (epoch ms) |
| `/tokenplan/personal/api/v2/quota-config` | — | Per-spec totals: `{ <specCode>: { five_hour, weekly } }` |

The response payload lives at `data.DataV2.data.data`, gated by `data.DataV2.ret[0]` (`SUCCESS::...`). Used credits per window = `total × usedRatio`. When quota-config is unavailable, windows fall back to percentage display. Naive datetimes in responses are treated as China time (UTC+8); epoch values are absolute.

### Teams plan (团队版)

On `platform-home.qianwenai.com`: `product=BssOpenAPI-V3`, `action=DescribeFrInstances`, form body additionally carries `language=zh-CN`. One call per commodity code: `sfm_tokenplanteams_dp_cn`, `sfm_tokenplansolo_public_cn`, `sfm_tokenplanpersonal_dp_cn` (legacy), `sfm_tokenplanteamsaddon_dp_cn` (add-on packs). Per instance: `Status.Code` (`"valid"` = active), `InitCapacityBaseValue` (total credits), `CurrCapacityBaseValue` (remaining; `periodCapacityBaseValue` when `CapacityTypeCode` is `periodMonthlyShift`), `EndTime` (epoch ms), `TemplateName`/`CommodityName`.

## Output

Individual plan:

- **Session** (overview progress): 5-hour window, used vs. total credits, resets at `per5HourResetTime`. Shown in the menu bar when Qwen is the selected provider.
- **Weekly** (overview progress): weekly window, used vs. total credits, resets at `per1WeekResetTime`.
- **Expires** (detail text): subscription expiry date.

Teams plan:

- **Credits** (overview progress): used vs. total credits, resets at the instance `EndTime`.
- **Remaining** (detail text): remaining credits.
- **Add-on** (detail text): summed remaining credits of valid add-on packs. Omitted when zero.
- **Expires** (detail text): reset/expiry date.

## Errors

| Condition | Message |
|---|---|
| Missing cookie (both sources) | `Qianwen console cookie missing. Copy the Cookie header from platform.qianwenai.com, then run: pbpaste > ~/.openusage/qwen-cookie.txt (or set QWEN_COOKIE).` |
| HTTP 401/403, 3xx redirect, login HTML, or `ConsoleNeedLogin` payload | `Qianwen console session expired. Copy a fresh Cookie header from platform.qianwenai.com, then run: pbpaste > ~/.openusage/qwen-cookie.txt.` |
| Other non-2xx | `Token Plan request failed (HTTP {status}). Try again later.` |
| Network failure on all calls | `Token Plan request failed. Check your connection.` |
| Unparseable payload | `Token Plan response invalid. Try again later.` |
| Console business error (non-auth) | `Token Plan API error: {message}` |
| No plan found on either path | `No active Token Plan subscription found for this account.` |
| Missing usage/capacity fields | `Could not parse Token Plan usage data.` / `Could not parse Token Plan data.` |
