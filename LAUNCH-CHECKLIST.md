# Launch checklist

What's left before lifestonelife.com is fully live. When an item is done, tell Claude (or edit this file) so it can be checked off and any site changes made.

## Waiting on Lifestone

- [ ] **Agency details for the footer and legal pages.** Send: legal agency name, Florida agency license number, and founding year (optional, for "Serving families since 19XX").
  - Claude then replaces `[AGENCY LEGAL NAME]` and `[AGENCY LICENSE #]` on every page.
- [ ] **Privacy Policy and Terms review.** IMO/FMO compliance or a Florida insurance/TCPA attorney reviews `privacy.html`, `terms.html` and the consent checkbox text.
  - Send Claude the approved wording (or "approved as written") and the effective date.
  - Claude then applies the changes, fills in `[DATE]`, and removes the "Pending compliance review" banners.
- [ ] **New-lead alerts.**
  - Email: Resend account, verify lifestonelife.com, add `RESEND_API_KEY` and `ALERT_FROM_EMAIL` in Netlify.
  - Text (optional): Twilio account plus A2P 10DLC business registration, then add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER` in Netlify.
- [ ] **Supabase settings.** Turn on leaked password protection, and set Email OTP expiration to 86400.
- [ ] **Backups.** Upgrade Supabase to Pro (daily backups) before real client data.
- [ ] **Team.** Invite agents from the CRM's Team page.
- [ ] **Live test.** Submit a quote on your phone, confirm it reaches the CRM (and the alert arrives), then archive it as "Duplicate / test."

## Recommended after launch

- [ ] Ad conversion tracking (Google Ads / Meta) on the thank-you page. The privacy policy must mention it.
- [ ] Google Business Profile and Google Search Console (submit `https://lifestonelife.com/sitemap.xml`).
- [ ] Use an @lifestonelife.com email instead of policies@lifestonesettlements.com.
- [ ] Add real reviews and the carriers you're appointed with (carriers usually require advertising approval first).

## Done

- [x] Website live on lifestonelife.com, quotes saved to the Lifestone CRM
- [x] CRM: leads, board, tasks and reminders, policies, reports, templates, files, archive, search
- [x] Every lead handled by a licensed agent (online application removed)
- [x] Sitemap and robots.txt
