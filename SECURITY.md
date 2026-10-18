# Security Policy

## Supported versions

Only the latest code on `main` is supported. Fixes are made there and are not backported.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem.

Report it privately instead:

1. Go to the **Security** tab of this repository and choose **Report a vulnerability**
   (GitHub's private vulnerability reporting), or
2. Email **shayankouri@gmail.com** with the subject line `Security: Dashavani Studio`.

Include what you found, the steps to reproduce it, and what an attacker could do with it. A proof of concept helps,
but please test only against your own copy of the studio, never someone else's.

You can expect:

- a reply within **3 days** confirming the report was received;
- an assessment within **7 days**, saying whether it's accepted and how serious it is;
- a fix on `main` as soon as practical, usually within **30 days** for serious issues. You'll be told when it lands
  and, if you like, credited in the fix.

## Scope

In scope: the code in this repository, including the server (`server.mjs`), sign-in and accounts (`auth.mjs`,
`users.mjs`), the pipeline and the web app.

Out of scope:

- the third-party services the studio calls (Gemini, ElevenLabs, HeyGen, YouTube, PIB, Cloudflare): report those to
  their owners;
- problems that need access to the machine running the studio, or to its `.env.local` or `data/` folder;
- denial of service by sending large amounts of traffic;
- missing hardening that has no practical attack behind it.

## How the studio protects itself

For context when looking for problems, the design is:

- API keys live only in the server's `.env.local`; the app never takes, stores or shows a key.
- Every page and action needs a signed, HttpOnly sign-in cookie; signing out or changing a password ends every
  session for that account.
- Each account sees only its own stories, videos and bulletins; owner actions are refused to everyone else.
  `access.test.mjs` checks every route as the owner, two editors and a signed-out visitor.
- Sign-in, sign-up and password resets are rate limited per connection and locked per email after repeated failures;
  signed-in actions are limited per account.
- Pages are sent with a Content-Security-Policy; uploads are checked by their actual bytes, not their declared type.
