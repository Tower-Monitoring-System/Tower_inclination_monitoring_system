# Supabase Sign-In Setup

This project authenticates with **username + password** without storing either account password or an account list in the browser source.

## Architecture

1. `public.profiles` stores only the public application identity: `id`, `username`, `display_name`, `role`.
2. Supabase Auth stores and verifies passwords.
3. The browser sends `username + password` to the `username-login` Edge Function over HTTPS.
4. The Edge Function privately resolves the username to the matching Supabase Auth user and asks Supabase Auth to verify the password.
5. The browser receives a normal Supabase session and the dashboard verifies the signed-in user plus that user's own `profiles` row.
6. Row Level Security only allows an authenticated user to read their own profile.

## Required setup

### 1. Auth users

Create/keep these two Auth users in **Authentication > Users** and set a strong password for each:

- `pnluat@gmail.com` -> Auth UID `04a38267-845c-4fdb-bd89-b77099cbd05e`
- `trannguyenhien29085@gmail.com` -> Auth UID `2d75316d-9d49-4f36-a88d-111a1ef56b4b`

Do not create a password column in `public.profiles`.

### 2. Run SQL

Open **SQL Editor**, paste `supabase/schema.sql`, then run it.

Expected usernames:

- `luatpham`
- `nguyenhien`

### 3. Disable public sign-up

In **Authentication > Settings / General configuration**, disable **Allow new users to sign up**. Keep anonymous sign-ins disabled.

### 4. Deploy the Edge Function

In the Supabase Dashboard, open **Edge Functions**, create a function named `username-login`, and paste the contents of:

`supabase/functions/username-login/index.ts`

The function must be configured with JWT verification disabled. If deploying with the CLI, `supabase/config.toml` already contains the required setting.

The server-side Supabase secret/service role key is provided to hosted Edge Functions by Supabase. Never copy that key into this website.

### 5. Configure the browser client

Open `js/core/supabaseConfig.js` and replace only:

- `https://YOUR_PROJECT_REF.supabase.co`
- `YOUR_SUPABASE_PUBLISHABLE_KEY`

Get them from the Supabase project **Connect** dialog or **Settings > API Keys**. Use a **publishable** key (`sb_publishable_...`). A publishable key is designed to be exposed in a browser application. Never use a secret key (`sb_secret_...`) or `service_role` key here.

### 6. Test

Serve the site through GitHub Pages or a local HTTP server, then test:

- `luatpham` + the password configured for `pnluat@gmail.com` -> success
- `nguyenhien` + the password configured for `trannguyenhien29085@gmail.com` -> success
- Any other username -> denied
- Either valid username with a wrong password -> denied
- Directly opening `index.html` without a valid Supabase session -> redirected to `sign-in.html`

## Security notes

- Passwords are never stored in this repository.
- Emails are not stored in the frontend source or `public.profiles`.
- The Edge Function uses server-side privileges only inside Supabase.
- `public.profiles` has RLS enabled and anonymous access revoked.
- The dashboard checks the authenticated user with Supabase before revealing protected UI.
- The "Remember username" option stores only the username in browser `localStorage`; it never stores the password.
