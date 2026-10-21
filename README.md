# Lifestone Life website

Static site hosted on Netlify. No build step. Lead handling runs in Netlify Functions.

## Pages

| Page | File |
|---|---|
| Homepage + quote quiz | [index.html](index.html) |
| Online application (simple cases) | [apply.html](apply.html) |
| Agent callback | [agent-callback.html](agent-callback.html) |
| Thank you (`?path=digital`, `?path=agent`, `?path=review`) | [thank-you.html](thank-you.html) |
| Free Policy Review | [policy-review.html](policy-review.html) |
| Privacy / Terms (pending compliance review) | [privacy.html](privacy.html), [terms.html](terms.html) |

`life-insurance.html` only forwards old links to the homepage.

## How a quote flows

1. The quiz (hero card or `#quote` form) saves the lead to Monday **first**, through `/.netlify/functions/lead`.
2. The routing rules decide the path:
   - **Digital** → `apply.html` → `/.netlify/functions/imo-submit` → `thank-you.html?path=digital`
   - **Agent** → `agent-callback.html` → `thank-you.html?path=agent`
3. If someone leaves `apply.html` without submitting, the lead is marked **Abandoned – agent follow up**.
4. If the function can't be reached, the browser keeps the lead and retries on the next page load.

SSN, bank and card details are never collected on this site. Health answers are only used to pick the path and are never stored in Monday.

## Change the routing rules

Everything is in [config/routing-rules.js](config/routing-rules.js): age range, max coverage, which coverage types can apply online, and more. The limits there are placeholders until they are confirmed with the carrier.

## Netlify setup

Set these under **Site configuration → Environment variables**:

| Variable | Value |
|---|---|
| `MONDAY_API_TOKEN` | Your Monday API token (Profile → Developers → My access tokens) |
| `MONDAY_BOARD_ID` | The number in the board's URL |
| `LEAD_SIGNING_SECRET` | Optional. Any long random string. Falls back to the API token. |

Then create the board columns once:

```
MONDAY_API_TOKEN=... MONDAY_BOARD_ID=... node scripts/setup-monday-board.js
```

Column IDs and types are listed in [config/monday-columns.js](config/monday-columns.js).

## Carrier integration

[netlify/functions/imo-submit.js](netlify/functions/imo-submit.js) is a placeholder. It returns `pending_manual` today and has TODOs for the approved, referred and declined responses.
