# Low Usage Alerts

Low usage alerts are optional and disabled by default. Enable them in **Settings → Low Usage Alerts**. The system may ask for notification permission the first time.

OhMyUsage sends a native notification when a bounded usage metric moves from more than 10% remaining to 10% or less during a successful refresh.

- The first reading after launch does not trigger an alert.
- A metric that stays at or below 10% does not trigger repeated alerts.
- After a usage limit resets above 10%, it can trigger again on a later crossing.
- If several metrics for one provider cross during the same refresh, only the lowest remaining metric is reported.
- Unlimited metrics and values without a valid positive limit are ignored.

Turning the setting off stops future alerts. If notifications were later blocked in system settings, re-enable permission there before alerts can appear again.
