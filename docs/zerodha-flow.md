# Zerodha Integration — API Flow & cURLs

> All requests require `x-session-token` header (your app session token).
> Replace `YOUR_SESSION_TOKEN`, `YOUR_API_KEY`, `YOUR_API_SECRET`, `YOUR_REQUEST_TOKEN` with real values.
> Base URL: `http://localhost:3000`

---

## Step 1 — Save Credentials

Save your Zerodha `api_key` and `api_secret`. Done once. The `api_secret` is encrypted before storage.

```bash
curl -X POST http://localhost:3000/api/zerodha/credentials \
  -H "x-session-token: YOUR_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "YOUR_API_KEY",
    "api_secret": "YOUR_API_SECRET"
  }'
```

**Success response:**
```json
{
  "status": "success",
  "data": {
    "message": "Credentials saved successfully"
  }
}
```

---

## Step 2 — Get Login URL

Fetch the Zerodha login URL. Your session token is automatically embedded as `state` so the backend can identify you when Zerodha redirects back.

```bash
curl -X GET http://localhost:3000/api/zerodha/auth-url \
  -H "x-session-token: YOUR_SESSION_TOKEN"
```

**Success response:**
```json
{
  "status": "success",
  "data": {
    "auth_url": "https://kite.zerodha.com/connect/login?v=3&api_key=YOUR_API_KEY&state=YOUR_SESSION_TOKEN"
  }
}
```

---

## Step 3 — User Logs In via Browser

Open the `auth_url` from Step 2 in a browser or Chrome Custom Tab.

After successful login, Zerodha redirects to:
```
https://wealth-backend-demo.onrender.com/api/kite/auth/callback
  ?request_token=XXXXXXXXXX
  &status=success
  &state=YOUR_SESSION_TOKEN
```

**Your backend handles this automatically** — no action needed from the app.
The backend will:
- Identify the user via the `state` (session token)
- Generate the SHA-256 checksum
- Exchange `request_token` for `access_token` with Kite
- Save `access_token` to the database
- Show a success page in the browser

The user sees: **"Zerodha Connected! You can close this window and return to the app."**

> If `status=error` in the redirect, Zerodha login failed — try again.

---

## Step 4 — Callback is Handled Automatically

This endpoint is called by Zerodha's redirect — **not by the app directly**.

```
GET https://wealth-backend-demo.onrender.com/api/kite/auth/callback
    ?request_token=XXXXXXXXXX&status=success&state=YOUR_SESSION_TOKEN
```

No cURL needed. The browser handles this after the Zerodha login in Step 3.

---

## Step 5 — Sync Holdings (after successful login)

Fetches live holdings from Kite API and upserts into the database.
Returns the synced holdings.

```bash
curl -X GET http://localhost:3000/api/holdings/sync \
  -H "x-session-token: YOUR_SESSION_TOKEN"
```

**Success response:**
```json
{
  "status": "success",
  "data": {
    "synced": 3,
    "holdings": [
      {
        "id": "uuid",
        "tradingsymbol": "INFY",
        "exchange": "NSE",
        "isin": "INE009A01021",
        "quantity": 10,
        "average_price": "1500.00",
        "last_price": "1600.00",
        "current_value": "16000.00",
        "pnl": "1000.00",
        "pnl_percentage": "6.67",
        "day_change": "10.00",
        "day_change_percentage": "0.63",
        "last_synced_at": "2026-03-08T10:30:00.000Z"
      }
    ]
  }
}
```

**If session expired (after 6AM IST):**
```json
{
  "status": "fail",
  "reason": "Zerodha session expired. Please re-authenticate via the login flow."
}
```

> If you get the expired error, repeat Steps 2 → 3 → 4 to get a fresh access_token.

---

## Bonus — Get Holdings from DB (no Kite call)

Reads holdings from your database without calling Zerodha.

```bash
curl -X GET http://localhost:3000/api/holdings \
  -H "x-session-token: YOUR_SESSION_TOKEN"
```

**Success response:**
```json
{
  "status": "success",
  "data": {
    "holdings": [...]
  }
}
```

---

## Error Reference

| Scenario | HTTP | reason |
|---|---|---|
| Missing `api_key` or `api_secret` in Step 1 | 400 | `api_key and api_secret are required` |
| Credentials not saved before Step 2/4 | 404 | `Zerodha credentials not found...` |
| Missing `request_token` in Step 4 | 400 | `request_token is required` |
| Kite rejected the token exchange | 502 | Kite error message |
| Access token expired (after 6AM IST) | 401 | `Zerodha session expired...` |
| Not authenticated before sync | 401 | `Zerodha not authenticated...` |
