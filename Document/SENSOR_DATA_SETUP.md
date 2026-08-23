# Google Sheets Sensor Data Setup

The List page uses only this secured path:

```text
Authenticated browser -> Supabase sensor-data Edge Function
                      -> Google Apps Script Web App -> Google Sheets
```

The browser never receives the Apps Script URL or the shared secret.

## 1. Prepare Google Sheets

Create a header row containing these six columns (capitalization is not important):

```text
Date | Time | X | Y | Z | Battery
```

- Format `Date` as a Google Sheets date and `Time` as a Google Sheets time.
- `X`, `Y`, and `Z` must be numeric degrees from `-180` to `180`.
- `Battery` must be a numeric voltage from `0` to `24`.
- Extra columns are ignored. Blank rows are ignored. Invalid rows are rejected without breaking valid rows.
- Set the spreadsheet time zone to the installation time zone (for example `GMT+07:00 Ho Chi Minh City`).

Copy the spreadsheet ID from its URL:

```text
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
```

## 2. Create and deploy the Apps Script Web App

1. Open [Google Apps Script](https://script.google.com/), create a project, and replace `Code.gs` with the repository file `google-apps-script/Code.gs`.
2. Open **Project Settings > Script properties** and add:

   | Property | Value |
   | --- | --- |
   | `SENSOR_SHEET_ID` | Google spreadsheet ID |
   | `SENSOR_SHEET_NAME` | Sheet tab name; optional, first tab is used when omitted |
   | `SENSOR_DATA_SHARED_SECRET` | Random secret of at least 32 bytes |

3. Create the secret with a cryptographically secure password generator. Use exactly the same value later in Supabase. Do not paste it into source code or commit it.
4. Choose **Deploy > New deployment > Web app**.
5. Set **Execute as** to **Me** and grant access so the Supabase server can call the web app. The shared secret still protects every data request.
6. Authorize read access to the spreadsheet and deploy.
7. Copy the deployed URL ending in `/exec`. Do not use the `/dev` test URL.

When `Code.gs` changes, create a new deployment version so `/exec` serves the updated code.

## 3. Configure and deploy Supabase

Install/login to the Supabase CLI, then link the repository to the intended project:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

Store the server-only configuration as Edge Function secrets:

```bash
supabase secrets set GOOGLE_APPS_SCRIPT_URL="https://script.google.com/macros/s/DEPLOYMENT_ID/exec"
supabase secrets set GOOGLE_APPS_SCRIPT_SHARED_SECRET="THE_SAME_RANDOM_SECRET"
supabase secrets set SENSOR_DATA_ALLOWED_ORIGINS="https://YOUR_SITE.example,http://localhost:8000"
```

`SENSOR_DATA_ALLOWED_ORIGINS` is a comma-separated list of exact origins without a trailing slash. It is optional for local setup but should be set in production.

Deploy the function:

```bash
supabase functions deploy sensor-data
```

Hosted Edge Functions already receive `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Never copy the service-role key into browser code.

The repository's `supabase/config.toml` enables gateway JWT verification for `sensor-data`. The function also verifies the user JWT and checks that `public.profiles.role` is `owner` or `operator` before contacting Apps Script.

## 4. Frontend configuration

The frontend configuration is in `js/core/config.js` under `SENSOR_DATA_CONFIG`:

- `edgeFunctionName`: deployed function name, normally `sensor-data`.
- `requestTimeoutMs`: browser request timeout.
- `pollingIntervalMs`: refresh interval while the List page is open (default 45 seconds).
- `pageSize`: rows displayed on each page.
- Battery warning/critical voltage thresholds.

Do not add the Apps Script URL or shared secret to this file. The existing public Supabase URL and publishable key remain in `js/core/supabaseConfig.js`.

## 5. Verify the complete flow

1. Sign in with an account whose profile role is `owner` or `operator`.
2. Open **List** in the sidebar.
3. Confirm the Sheet rows appear and Day/Month/Year filtering, Date/Time sorting, pagination, and `.xlsx` export work.
4. Add a valid row to Google Sheets.
5. Click **Refresh** or wait for the next polling cycle. The new row must appear without changing source code.
6. Temporarily disable the Apps Script deployment and confirm the List page shows an error while retaining the last valid readings.
7. Navigate back to **Overview** and confirm List polling stops.

## Security checklist

- Keep only the Supabase publishable key in frontend code.
- Keep the Apps Script URL and shared secret in Supabase Edge Function Secrets.
- Keep the matching shared secret in Apps Script Properties.
- Never send the shared secret in a URL/query string.
- Never log or return the shared secret.
- Rotate the secret in both Supabase and Apps Script if it may have been exposed.
