# TEZMO PRO EA - release package (Vercel)

Folder layout (deploy the whole folder to Vercel from Git or with the Vercel CLI, so the web-push package gets installed):

  index.html            the app (give buyers the site LINK, never this file)
  sw.js, manifest.webmanifest, icon-192.png, icon-512.png   phone install + notifications
  package.json, vercel.json
  api/access.js         email approval (every email needs your approval, except the owner)
  api/ai.js             keeps your AI keys on the server, free models only
  api/research.js       live web research once per event, shared by all buyers
  api/calendar.js       economic calendar feed
  api/bot.js            shared signals + phone notifications (the owner publishes, clients receive)
  lib/store.js, lib/auth.js   storage and the access / owner rules

## 1. Storage (one time)
Vercel project > Storage > Create > Upstash Redis (Marketplace) > connect it to this project.
Vercel adds KV_REST_API_URL and KV_REST_API_TOKEN by itself. Redeploy once after connecting.

## 2. Environment variables (Vercel > Settings > Environment Variables)
  ACCESS_SECRET   long random text (30+ characters)
  ADMIN_TOKEN     another long random text. This is the owner's admin token: you type it in the app Setup
                  and on the admin page.
  RESEND_API_KEY  free key from resend.com. Sign up with tumeloseleka74@gmail.com so approval emails reach you.
  GEMINI_KEY      a FREE-tier Google AI Studio key (do not link billing to its project)
  GROQ_KEY        your free Groq key
  TAVILY_KEY      free key from tavily.com (live web search for news / US Open research)
Optional: OWNER_EMAIL (default tumeloseleka74@gmail.com), SITE_URL, MAIL_FROM, AI_PER_HOUR (150),
          SEARCH_PER_DAY (150), RESEARCH_PER_HOUR (40).
No SIGNAL_TOKEN is needed any more. MT5 connects straight to the broker through mtapi.io, so the old PC bridge is gone.

## 3. Owner and clients
- tumeloseleka74@gmail.com is the owner. The owner needs no approval and no API key.
  An email address alone is not a password, so the owner email skips approval only on the owner's own device:
  the first device that opens the app with the owner email is remembered (open the site yourself right after deploying),
  and any device that sends the correct ADMIN_TOKEN is added too. Another device with the owner email goes through the
  normal approval email like everyone else.
  If the wrong device ever got in first: admin page > Reset owner devices, then open the app on your phone again.
- Every other email must be approved. A buyer opens your link, types their email and their own API key, taps Request access.
  You get an email, tap Approve, their app opens by itself. One email = one approval = one phone.
- Admin page (revoke, reset devices, pre-approve, reset owner devices):  https://YOUR-SITE.vercel.app/api/access?a=admin

## 4. Owner: admin token in Setup
Open the app with the owner email > AI Scanner tab > Setup > "Admin token (owner only)" > type ADMIN_TOKEN once > Save token.
From then on every completed BUY or SELL from the AI Scanner, Auto analyze, Auto watch, News prediction, News result and US Open
is published once to every client who pressed START on Home (circle, banner and phone notification).
Untick "Publish my signals to all clients" in the same box to pause publishing.

## 5. Execute on MT5
Every signal has an execute button that opens the MT5 confirmation (lot size, number of trades, checks), then sends the order:
AI Scanner result, Auto analyze result, News prediction, News result, US Open card, and the signal banner (which also covers
Auto watch and the signals clients receive from the owner). If MT5 is not connected the button takes you to the MetaTrader tab.
The MetaTrader tab shows Account, Open trades and Orders sent from this app (the quote check / Get price box was removed).
The "Match my broker prices" box was removed from the AI Scanner Setup.

## Notes
- Phone notifications: no extra settings. The push keys are created once by the server and kept in the database.
  iPhone: only after Share > Add to Home Screen and opening the app from the home screen.
- Update banner: change the number in <meta name="app-version"> and APP_VERSION in index.html when you release.
- AI screenshots go through api/ai.js. Vercel accepts requests up to 4.5 MB, so very large screenshots are refused.
