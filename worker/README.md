# Fedok 144 Suites Worker starter

This is the backend folder for the existing FedokHotel repository. Keep it
separate from the existing Pages website files.

Configured resources:
- Worker: `fedok144-api`
- D1 binding `DB` -> `fedok144-db`
- R2 binding `MEDIA` -> `fedok144-media`

## Add to GitHub
Copy this folder into the root of the existing `FedokHotel` repository so it
appears as `/worker`. Do not replace or move existing website files.

## Cloudflare Worker Builds
For the existing Worker, configure:
- Repository: `Lawrenceebialex/FedokHotel`
- Root directory: `worker`
- Build command: leave blank
- Deploy command: `npx wrangler deploy`

Do not connect/deploy until these files are committed to GitHub. Keep the
existing Pages project settings unchanged. Check the production branch setting
before enabling automatic deployments.

## Test
After deployment, open:
`https://fedok144-api.<your-workers-subdomain>.workers.dev/health`

Expected: worker `online`, database `connected`, storage `connected`.

The Pages origin `https://fedokhotel.pages.dev` is allowed for browser API
requests. If the website later uses a custom domain, add its exact origin to
`ALLOWED_ORIGINS` in `src/index.js`.

## Secrets
Never commit Paystack secret keys, email credentials, passwords, or API tokens.
Add those later as Cloudflare Worker secrets.
