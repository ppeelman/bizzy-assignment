# Eval Results

- **Target:** http://localhost:3000
- **Ran at:** 2026-04-25T18:12:57.964Z
- **Model:** claude-sonnet-4-5-20250929
- **Companies:** 7 (6 ok, 1 failed)

## Aggregate

- Summary present: **6/7**
- Industry match: **5/7**
- News present: **3/7**
- News keyword match: **3/7**

## By tier

| Tier | n | summary | industry | contacts (recall) | news | avg s |
|------|---|---------|----------|-------------------|------|-------|
| big-us | 2 | 2/2 | 2/2 | 0.00 | 1/2 | 13.1 |
| mid-eu | 2 | 2/2 | 2/2 | 0.00 | 1/2 | 14.3 |
| small-be | 2 | 2/2 | 1/2 | 0.00 | 1/2 | 8.5 |
| obscure | 1 | 0/1 | 0/1 | — | 0/1 | 0.0 |

## Per-company

| Company | Tier | Summary | Industry | Contacts | News | Runtime | Notes |
|---------|------|---------|----------|----------|------|---------|-------|
| stripe.com | big-us | ✓ | ✓ | 0/2 | ✗* | 9.8s | 2v/0i/0u |
| figma.com | big-us | ✓ | ✓ | 2/1 | ✓ | 16.3s | 6v/0i/0u |
| teamleader.eu | small-be | ✓ | ✓ | 0/2 | ✗* | 8.8s | 2v/0i/0u |
| mollie.com | mid-eu | ✓ | ✓ | 0/2 | ✗* | 16.2s | 2v/0i/0u |
| intigriti.com | mid-eu | ✓ | ✓ | 2/1 | ✓ | 12.4s | 5v/0i/0u |
| showpad.com | small-be | ✓ | ✗ | 0/2 | ✓ | 8.1s | 3v/0i/0u |
| bizzy.eu | obscure | ✗ | ✗ | — | — | — | source_fetch_failed |

`*` = news returned but no expected keyword matched.

Confidence distribution `Xv/Yi/Zu` = verified / inferred / unknown across summary + industry + each contact + each news item.
