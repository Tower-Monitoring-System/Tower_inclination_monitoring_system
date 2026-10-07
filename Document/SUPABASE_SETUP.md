# Supabase Backend & Authentication Setup

This project uses **Supabase** for secure username-based authentication and proxying protected sensor telemetry requests.

---

## 1. Architecture Overview

```text
Browser (Sign-in) --(username + password)--> Edge Function: username-login
                                            ├── Resolves username in public.profiles
                                            ├── Verifies password against Supabase Auth
                                            └── Issues JWT Session to browser

Browser (Dashboard) --(Bearer JWT + towerId)--> Edge Function: sensor-data
                                                ├── Verifies user JWT & profile role (owner/operator)
                                                └── Proxies request to Google Apps Script Web App
```

1. **`public.profiles`**: Stores public user details (`id`, `username`, `display_name`, `role`). Never stores passwords.
2. **Supabase Auth (`auth.users`)**: Manages encrypted passwords, tokens, and identities.
3. **`username-login` Edge Function**: Acts as a secure intermediary to permit login via clean username instead of raw email, with uniform response delay to prevent timing attacks.
4. **`sensor-data` Edge Function**: Validates user credentials, roles, and origin before fetching Google Sheets data through Google Apps Script.

---

## 2. Step-by-Step Setup Guide

### Step 1: Create Supabase Auth Users

In your Supabase project dashboard, navigate to **Authentication > Users** and click **Add user > Create user**:

1. User 1:
   - **Email:** `pnluat@gmail.com`
   - **Password:** Set a strong password.
   - **Auto Confirm:** Checked.
2. User 2:
   - **Email:** `trannguyenhien29085@gmail.com`
   - **Password:** Set a strong password.
   - **Auto Confirm:** Checked.

> [!IMPORTANT]
> **Check your generated Auth UIDs!**  
> Supabase assigns a unique UUID to every newly created user. Note the generated User UID for each user (shown in the **UID** column in Authentication > Users).

---

### Step 2: Configure Database & Profiles (`schema.sql`)

1. Open [`supabase/schema.sql`](../supabase/schema.sql).
2. Check lines 44–47:
   ```sql
   insert into public.profiles (id, username, display_name, role)
   values
     ('YOUR_USER_1_UID', 'luatpham', 'Luat Pham', 'owner'),
     ('YOUR_USER_2_UID', 'nguyenhien', 'Nguyen Hien', 'owner')
   on conflict (id) do update
   set
     username = excluded.username,
     display_name = excluded.display_name,
     role = excluded.role;
   ```
   *Replace the sample UUIDs with the actual Auth UIDs generated in Step 1 if you are setting up a fresh Supabase project.*
3. Open **SQL Editor** in Supabase, paste the entire content of `supabase/schema.sql`, and click **Run**.
4. Confirm:
   - Row Level Security (RLS) is enabled on `public.profiles`.
   - Users can only read their own profile row.
   - Anonymous access to `public.profiles` is completely revoked.

---

### Step 3: Configure Authentication Settings

In **Authentication > Configuration > General**:
- Turn **OFF** **Allow new users to sign up** (prevents unauthorized public registrations).
- Keep anonymous sign-ins disabled.

---

### Step 4: Deploy Edge Functions

The repository contains two Edge Functions in `supabase/functions/`:

#### A. Deploy `username-login` (Public Login Handler)
- **JWT Verification:** Must be **Disabled** (`verify_jwt = false` in `supabase/config.toml`), because unauthenticated users calling this endpoint do not possess a JWT yet.
- Deployment via CLI:
  ```bash
  supabase functions deploy username-login
  ```
- Or via Supabase Dashboard: Create an Edge Function named `username-login` and paste [`supabase/functions/username-login/index.ts`](../supabase/functions/username-login/index.ts). Ensure **Enforce JWT verification** is toggled **OFF**.

#### B. Deploy `sensor-data` (Protected Telemetry Proxy)
- **JWT Verification:** Must be **Enabled** (`verify_jwt = true`).
- Set required environment secrets:
  ```bash
  supabase secrets set GOOGLE_APPS_SCRIPT_URL="https://script.google.com/macros/s/DEPLOYMENT_ID/exec"
  supabase secrets set GOOGLE_APPS_SCRIPT_SHARED_SECRET="YOUR_SHARED_SECRET_KEY"
  supabase secrets set SENSOR_DATA_ALLOWED_ORIGINS="http://localhost:8000,https://YOUR_DOMAIN.example"
  ```
- Deploy via CLI:
  ```bash
  supabase functions deploy sensor-data
  ```
- Or via Supabase Dashboard: Create function `sensor-data`, paste [`supabase/functions/sensor-data/index.ts`](../supabase/functions/sensor-data/index.ts), and set the secrets under **Edge Functions > Secrets**.

---

### Step 5: Configure Frontend Client

Open [`js/core/supabaseConfig.js`](../js/core/supabaseConfig.js) and update your public project credentials:

```javascript
export const SUPABASE_CONFIG = Object.freeze({
  url: "https://YOUR_PROJECT_REF.supabase.co",
  publishableKey: "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY",
  usernameLoginFunction: "username-login"
});
```

> [!CAUTION]
> **Use the Publishable / Anon Key only!**  
> Found in **Settings > API** as `anon` or `publishableKey`. Never put your `service_role` or secret key into frontend code.

---

### Step 6: Testing & Verification

Serve the website locally (e.g., `python -m http.server 8000`) or via hosting:

1. **Successful Login:**
   - Sign in with username `luatpham` and the password set for `pnluat@gmail.com` $\rightarrow$ Redirects to `index.html`.
   - Sign in with username `nguyenhien` and the password set for `trannguyenhien29085@gmail.com` $\rightarrow$ Redirects to `index.html`.
2. **Access Control:**
   - Attempting to open `index.html` directly in a fresh incognito window $\rightarrow$ Redirects to `sign-in.html`.
   - Entering an incorrect password or unregistered username $\rightarrow$ Displays *"Invalid username or password."* after a standardized delay.
3. **Session Management:**
   - Closing the browser tab terminates the active session (stored securely in `sessionStorage`).
   - "Remember username" stores only the username text in `localStorage` for convenience; it never remembers passwords.

---

## 3. Security Checklist

- [x] Passwords are never stored in the database schema or code repository.
- [x] Client browser never interacts directly with Google Apps Script or the shared secret.
- [x] Only accounts with role `owner` or `operator` are permitted to view sensor data.
- [x] Edge Function `username-login` uses constant-time delay mitigation against brute-force attacks.
- [x] Row Level Security (RLS) restricts profile access to the owning user only.
