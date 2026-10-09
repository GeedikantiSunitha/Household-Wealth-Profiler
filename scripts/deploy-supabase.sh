#!/bin/sh
# Deploys the Supabase edition. Run from the project root.
#   1. Create a Supabase project in the London region (eu-west-2) and note its reference.
#   2. Install the Supabase CLI and run `supabase login`.
#   3. Export the variables below, then: scripts/deploy-supabase.sh
#
#   SUPABASE_PROJECT_REF      e.g. abcdefghijklmnopqrst
#   SUPABASE_PUBLISHABLE_KEY  Project Settings > API Keys (publishable / anon)
#   APP_ORIGIN                where the front end will live, e.g. https://wealth-profiler.pages.dev
#   PAGES_PROJECT             Cloudflare Pages project name (needs `npx wrangler login`)
set -eu
: "${SUPABASE_PROJECT_REF:?}" "${SUPABASE_PUBLISHABLE_KEY:?}" "${APP_ORIGIN:?}" "${PAGES_PROJECT:?}"
export SUPABASE_URL="https://$SUPABASE_PROJECT_REF.supabase.co"

npm test
supabase link --project-ref "$SUPABASE_PROJECT_REF"
supabase db push                                   # tables, retention rules, access rules
supabase config push                               # sign-in settings from supabase/config.toml
npm run sync:supabase
supabase functions deploy api --use-api --no-verify-jwt
supabase secrets set APP_ORIGINS="$APP_ORIGIN"
node scripts/build-web.js
npx wrangler@4 pages deploy dist/web --project-name "$PAGES_PROJECT" --branch main
echo
echo "Deployed. Create your first customer firm with:"
echo "  SUPABASE_URL=$SUPABASE_URL SUPABASE_SECRET_KEY=... APP_ORIGIN=$APP_ORIGIN node scripts/firms.js create \"Firm\" admin@firm.co.uk \"Admin Name\" 5"
