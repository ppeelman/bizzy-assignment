# Eval Results

- **Target:** http://localhost:3000
- **Ran at:** 2026-04-25T19:02:01.647Z
- **Model:** claude-sonnet-4-5-20250929
- **Companies:** 7 (7 ok, 0 failed)

## Aggregate

- Summary present: **7/7**
- Industry match: **6/7**
- News present: **3/7**
- News keyword match: **3/7**

## By tier

| Tier | n | summary | industry | contacts (recall) | news | avg s |
|------|---|---------|----------|-------------------|------|-------|
| big-us | 2 | 2/2 | 2/2 | 0.00 | 1/2 | 15.3 |
| mid-eu | 2 | 2/2 | 2/2 | 0.00 | 1/2 | 8.8 |
| small-be | 2 | 2/2 | 1/2 | 0.00 | 1/2 | 8.0 |
| obscure | 1 | 1/1 | 1/1 | 1.00 | 0/1 | 11.1 |

## Per-company

| Company | Tier | Summary | Industry | Contacts | News | Runtime | Notes |
|---------|------|---------|----------|----------|------|---------|-------|
| stripe.com | big-us | ✓ | ✓ | 3/2 | ✗* | 13.7s | 5v/0i/0u |
| figma.com | big-us | ✓ | ✓ | 2/1 | ✓ | 16.9s | 6v/0i/0u |
| teamleader.eu | small-be | ✓ | ✓ | 0/2 | ✗* | 7.5s | 2v/0i/0u |
| mollie.com | mid-eu | ✓ | ✓ | 0/2 | ✗* | 7.5s | 2v/0i/0u |
| intigriti.com | mid-eu | ✓ | ✓ | 0/1 | ✓ | 10.1s | 3v/0i/0u |
| showpad.com | small-be | ✓ | ✗ | 0/2 | ✓ | 8.4s | 3v/0i/0u |
| bizzy.ai | obscure | ✓ | ✓ | 3/— | ✗* | 11.1s | 5v/0i/0u |

`*` = news returned but no expected keyword matched.

Confidence distribution `Xv/Yi/Zu` = verified / inferred / unknown across summary + industry + each contact + each news item.
