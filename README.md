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
| Team CRM dashboard (login required) | [admin/](admin/) |

`life-insurance.html` only forwards old links to the homepage.

## How a quote flows

1. The quiz (hero card or `#quote` form) saves the lead **first**, through `/.netlify/functions/lead`, into the Lifestone CRM.
2. The routing rules decide the path:
   - **Digital** → `apply.html` → `/.netlify/functions/imo-submit` → `thank-you.html?path=digital`
   - **Agent** → `agent-callback.html` → `thank-you.html?path=agent`
3. If someone leaves `apply.html` without submitting, the lead is marked **Abandoned – follow up**.
4. If the function can't be reached, the browser keeps the lead and retries on the next page load.
5. Admins get an email and/or text for every new lead.

SSN, bank and card details are never collected on this site. Health answers are only used to pick the path and are never stored.

## Change the routing rules

Everything is in [config/routing-rules.js](config/routing-rules.js): age range, coverage limits, which coverage types can apply online, and more. The limits there are placeholders until they are confirmed with the carrier.

## Lifestone CRM (`/admin`)

Our own lead dashboard at **lifestonelife.com/admin**. Agents sign in with a password plus a code from an authenticator app.

- **Admins** see every lead, assign leads, invite and turn off team members.
- **Agents** see only the leads assigned to them.
- Every lead has status, notes, call/text/email buttons and a full history.
- Files (PDFs, photos, Word, Excel, up to 25 MB) can be attached to a lead. They're stored in a private Supabase bucket; only people who can see the lead can open them, and downloads use links that expire after 60 seconds.

The data lives in [Supabase](https://supabase.com). Access rules are enforced by the database ([supabase/schema.sql](supabase/schema.sql)), not just the page.
Lead statuses are in [config/lead-statuses.js](config/lead-statuses.js).

### One-time setup

1. **Create a Supabase project** (free tier is fine). Pick the US East region.
2. **Run the database setup:** Supabase → SQL Editor → New query → paste all of `supabase/schema.sql` → Run. (Or run `supabase/parts/1` to `4` in order.)
3. **Auth settings** (Supabase → Authentication):
   - Sign In / Providers → Email: turn **off** "Allow new users to sign up" (only invited people get in).
   - URL Configuration: Site URL `https://lifestonelife.com/admin/`, and add `https://lifestonelife.com/admin/` to Redirect URLs.
   - Multi-Factor: make sure **TOTP (authenticator app)** is enabled.
4. **Add Netlify environment variables** (below), then redeploy.
5. **Create the first admin:** Supabase → Authentication → Users → Add user → Send invitation, using your email.
   The first account ever created becomes an admin automatically. Open the email, set a password, set up two-step verification.
6. Invite everyone else from the dashboard's **Team** page.

### Netlify environment variables

| Variable | Required | Where to find it |
|---|---|---|
| `SUPABASE_URL` | Yes | Supabase → Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Yes | Same page, the `anon` / publishable key (safe for browsers) |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Same page, the `service_role` / secret key. **Never share this.** |
| `LEAD_SIGNING_SECRET` | Recommended | Any long random string |
| `SITE_URL` | Optional | `https://lifestonelife.com` (used in alert links; defaults to Netlify's site URL) |
| `RESEND_API_KEY` | For email alerts | [resend.com](https://resend.com) → API Keys |
| `ALERT_FROM_EMAIL` | For email alerts | e.g. `Lifestone Leads <leads@lifestonelife.com>` (domain verified in Resend) |
| `TWILIO_ACCOUNT_SID` | For text alerts | [twilio.com](https://twilio.com) console |
| `TWILIO_AUTH_TOKEN` | For text alerts | Twilio console |
| `TWILIO_FROM_NUMBER` | For text alerts | Your Twilio number, e.g. `+19545550000` |

Each person picks email and/or text alerts on the dashboard's **Settings** page.

Mark `SUPABASE_SERVICE_ROLE_KEY`, `LEAD_SIGNING_SECRET`, `RESEND_API_KEY` and `TWILIO_AUTH_TOKEN` as **Contains secret values** in Netlify. Netlify only allows secret values for real deploy contexts (Production etc.), not "all". After adding or changing any variable, redeploy so the functions pick it up.

### Common admin tasks

- **Someone lost their phone (2-step codes):** Supabase → Authentication → Users → their account → remove the MFA factor. They set it up again at next sign-in.
- **Someone leaves:** Team page → Account **Off** → Save. Their open leads go back to Unassigned.
- **Backups:** the free tier keeps none you can restore yourself. Supabase Pro (about $25/month) adds daily backups. Recommended once real leads are coming in.

## Carrier integration

[netlify/functions/imo-submit.js](netlify/functions/imo-submit.js) is a placeholder. It returns `pending_manual` today and has TODOs for the approved, referred and declined responses.
