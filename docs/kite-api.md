# Kite Connect API — Free Plan Reference

> **Base URL:** `https://api.kite.trade`
> **Required headers on every request:**
> ```
> X-Kite-Version: 3
> Authorization: token api_key:access_token
> ```
> Replace `api_key` and `access_token` with real values.
> `access_token` expires daily at **6:00 AM IST** — re-auth required after that.

---

## 1. Authentication

### Step 1 — Redirect user to Zerodha login
Not a cURL. Open this URL in a browser / Chrome Custom Tab:
```
https://kite.zerodha.com/connect/login?v=3&api_key=zvzunhd71pl2vkzm
```
Zerodha redirects back to your registered redirect URL with `?request_token=...&status=success`.

---

### Step 2 — Exchange request_token for access_token
```bash
curl -X POST "https://api.kite.trade/session/token" \
  -H "X-Kite-Version: 3" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "api_key=zvzunhd71pl2vkzm" \
  -d "request_token=REQUEST_TOKEN_HERE" \
  -d "checksum=SHA256_CHECKSUM_HERE"
```
**Checksum formula (SHA-256):**
```
checksum = sha256(api_key + request_token + api_secret)
```
The `kiteconnect` npm package handles this automatically via `kc.generateSession()`.

**Response:**
```json
{
  "status": "success",
  "data": {
    "access_token": "yyyyyy",
    "user_id": "AB1234",
    "user_name": "John Doe",
    "user_shortname": "John",
    "email": "john@example.com",
    "user_type": "individual",
    "broker": "ZERODHA",
    "login_time": "2024-01-01 09:15:00"
  }
}
```

---

### Step 3 — Delete session (logout from Kite)
```bash
curl -X DELETE "https://api.kite.trade/session/token" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```

---

## 2. User

### Get Profile
```bash
curl -X GET "https://api.kite.trade/user/profile" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```
**Response:**
```json
{
  "status": "success",
  "data": {
    "user_id": "AB1234",
    "user_name": "John Doe",
    "email": "john@example.com",
    "user_type": "individual",
    "broker": "ZERODHA",
    "exchanges": ["NSE", "BSE", "NFO", "CDS", "BFO", "MCX"],
    "products": ["CNC", "MIS", "NRML", "CO"],
    "order_types": ["MARKET", "LIMIT", "SL", "SL-M"]
  }
}
```

---

### Get Funds & Margins (all segments)
```bash
curl -X GET "https://api.kite.trade/user/margins" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```

### Get Funds & Margins (specific segment)
Segment values: `equity` | `commodity`
```bash
curl -X GET "https://api.kite.trade/user/margins/equity" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```
**Response:**
```json
{
  "status": "success",
  "data": {
    "equity": {
      "enabled": true,
      "net": 10000.00,
      "available": {
        "adhoc_margin": 0,
        "cash": 10000.00,
        "opening_balance": 10000.00,
        "live_balance": 10000.00,
        "collateral": 0,
        "intraday_payin": 0
      },
      "utilised": {
        "debits": 0,
        "exposure": 0,
        "m2m_realised": 0,
        "m2m_unrealised": 0,
        "option_premium": 0,
        "payout": 0,
        "span": 0,
        "holding_sales": 0,
        "turnover": 0
      }
    }
  }
}
```

---

## 3. Portfolio

### Get Holdings
```bash
curl -X GET "https://api.kite.trade/portfolio/holdings" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```
**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "tradingsymbol": "INFY",
      "exchange": "NSE",
      "isin": "INE009A01021",
      "instrument_token": 408065,
      "quantity": 10,
      "average_price": 1500.00,
      "last_price": 1600.00,
      "pnl": 1000.00,
      "day_change": 10.00,
      "day_change_percentage": 0.63,
      "close_price": 1590.00,
      "t1_quantity": 0,
      "realised_quantity": 10,
      "collateral_quantity": 0,
      "collateral_type": ""
    }
  ]
}
```

---

### Get Positions
```bash
curl -X GET "https://api.kite.trade/portfolio/positions" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```
**Response:** Returns two arrays — `net` (overall) and `day` (intraday).
```json
{
  "status": "success",
  "data": {
    "net": [
      {
        "tradingsymbol": "INFY",
        "exchange": "NSE",
        "instrument_token": 408065,
        "product": "MIS",
        "quantity": 10,
        "overnight_quantity": 0,
        "multiplier": 1,
        "average_price": 1500.00,
        "close_price": 1590.00,
        "last_price": 1600.00,
        "value": 15000.00,
        "pnl": 1000.00,
        "m2m": 100.00,
        "unrealised": 1000.00,
        "realised": 0.00,
        "buy_quantity": 10,
        "buy_price": 1500.00,
        "buy_value": 15000.00,
        "sell_quantity": 0,
        "sell_price": 0,
        "sell_value": 0,
        "day_buy_quantity": 10,
        "day_buy_price": 1500.00,
        "day_buy_value": 15000.00,
        "day_sell_quantity": 0,
        "day_sell_price": 0,
        "day_sell_value": 0
      }
    ],
    "day": []
  }
}
```

---

### Convert Position
```bash
curl -X PUT "https://api.kite.trade/portfolio/positions" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "tradingsymbol=INFY" \
  -d "exchange=NSE" \
  -d "transaction_type=BUY" \
  -d "position_type=day" \
  -d "quantity=10" \
  -d "old_product=MIS" \
  -d "new_product=CNC"
```

---

## 4. Orders

### Get All Orders (for the day)
```bash
curl -X GET "https://api.kite.trade/orders" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```
**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "order_id": "220101000000000",
      "parent_order_id": null,
      "exchange_order_id": "1000000000000000",
      "placed_by": "AB1234",
      "variety": "regular",
      "status": "COMPLETE",
      "tradingsymbol": "INFY",
      "exchange": "NSE",
      "instrument_token": 408065,
      "transaction_type": "BUY",
      "order_type": "MARKET",
      "product": "CNC",
      "validity": "DAY",
      "price": 0,
      "quantity": 10,
      "trigger_price": 0,
      "average_price": 1500.00,
      "pending_quantity": 0,
      "filled_quantity": 10,
      "disclosed_quantity": 0,
      "market_protection": 0,
      "order_timestamp": "2024-01-01 09:30:00",
      "exchange_timestamp": "2024-01-01 09:30:01",
      "status_message": null,
      "tag": null
    }
  ]
}
```

---

### Get Trades for an Order
```bash
curl -X GET "https://api.kite.trade/orders/ORDER_ID/trades" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```

---

### Get All Trades (for the day)
```bash
curl -X GET "https://api.kite.trade/trades" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```

---

### Place Order
**Variety values:** `regular` | `amo` (After Market) | `co` (Cover Order) | `iceberg` | `auction`
**Product values:** `CNC` (delivery) | `MIS` (intraday) | `NRML` (futures/options)
**Order type values:** `MARKET` | `LIMIT` | `SL` | `SL-M`
**Transaction type:** `BUY` | `SELL`
**Validity values:** `DAY` | `IOC` | `TTT`

```bash
# Market order
curl -X POST "https://api.kite.trade/orders/regular" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "tradingsymbol=INFY" \
  -d "exchange=NSE" \
  -d "transaction_type=BUY" \
  -d "order_type=MARKET" \
  -d "quantity=10" \
  -d "product=CNC" \
  -d "validity=DAY"
```

```bash
# Limit order
curl -X POST "https://api.kite.trade/orders/regular" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "tradingsymbol=INFY" \
  -d "exchange=NSE" \
  -d "transaction_type=BUY" \
  -d "order_type=LIMIT" \
  -d "quantity=10" \
  -d "product=CNC" \
  -d "price=1500.00" \
  -d "validity=DAY"
```

```bash
# Stop-loss order (SL)
curl -X POST "https://api.kite.trade/orders/regular" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "tradingsymbol=INFY" \
  -d "exchange=NSE" \
  -d "transaction_type=SELL" \
  -d "order_type=SL" \
  -d "quantity=10" \
  -d "product=CNC" \
  -d "price=1480.00" \
  -d "trigger_price=1490.00" \
  -d "validity=DAY"
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "order_id": "220101000000000"
  }
}
```

---

### Modify Order
```bash
curl -X PUT "https://api.kite.trade/orders/regular/ORDER_ID" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "order_type=LIMIT" \
  -d "quantity=10" \
  -d "price=1510.00" \
  -d "validity=DAY"
```

---

### Cancel Order
```bash
curl -X DELETE "https://api.kite.trade/orders/regular/ORDER_ID" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```

---

## 5. GTT (Good Till Triggered)

### Get All GTT Triggers
```bash
curl -X GET "https://api.kite.trade/gtt/triggers" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```
**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "id": 123,
      "type": "single",
      "created_at": "2024-01-01 10:00:00",
      "updated_at": "2024-01-01 10:00:00",
      "expires_at": "2025-01-01 10:00:00",
      "status": "active",
      "condition": {
        "exchange": "NSE",
        "tradingsymbol": "INFY",
        "trigger_values": [1400.00],
        "last_price": 1500.00
      },
      "orders": [
        {
          "exchange": "NSE",
          "tradingsymbol": "INFY",
          "transaction_type": "SELL",
          "quantity": 10,
          "product": "CNC",
          "order_type": "LIMIT",
          "price": 1400.00
        }
      ]
    }
  ]
}
```

---

### Get Single GTT Trigger
```bash
curl -X GET "https://api.kite.trade/gtt/triggers/GTT_ID" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```

---

### Create GTT Trigger
**Trigger type:** `single` (one price level) | `two-leg` (OCO — target + stop-loss)

```bash
# Single trigger (e.g. sell if price drops to 1400)
curl -X POST "https://api.kite.trade/gtt/triggers" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "single",
    "condition": {
      "exchange": "NSE",
      "tradingsymbol": "INFY",
      "trigger_values": [1400.00],
      "last_price": 1500.00
    },
    "orders": [
      {
        "exchange": "NSE",
        "tradingsymbol": "INFY",
        "transaction_type": "SELL",
        "quantity": 10,
        "product": "CNC",
        "order_type": "LIMIT",
        "price": 1400.00
      }
    ]
  }'
```

```bash
# Two-leg trigger (OCO: target sell at 1700, stop-loss sell at 1400)
curl -X POST "https://api.kite.trade/gtt/triggers" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "two-leg",
    "condition": {
      "exchange": "NSE",
      "tradingsymbol": "INFY",
      "trigger_values": [1400.00, 1700.00],
      "last_price": 1500.00
    },
    "orders": [
      {
        "exchange": "NSE",
        "tradingsymbol": "INFY",
        "transaction_type": "SELL",
        "quantity": 10,
        "product": "CNC",
        "order_type": "LIMIT",
        "price": 1400.00
      },
      {
        "exchange": "NSE",
        "tradingsymbol": "INFY",
        "transaction_type": "SELL",
        "quantity": 10,
        "product": "CNC",
        "order_type": "LIMIT",
        "price": 1700.00
      }
    ]
  }'
```

**Response:**
```json
{
  "status": "success",
  "data": { "trigger_id": 123 }
}
```

---

### Modify GTT Trigger
```bash
curl -X PUT "https://api.kite.trade/gtt/triggers/GTT_ID" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "single",
    "condition": {
      "exchange": "NSE",
      "tradingsymbol": "INFY",
      "trigger_values": [1350.00],
      "last_price": 1500.00
    },
    "orders": [
      {
        "exchange": "NSE",
        "tradingsymbol": "INFY",
        "transaction_type": "SELL",
        "quantity": 10,
        "product": "CNC",
        "order_type": "LIMIT",
        "price": 1350.00
      }
    ]
  }'
```

---

### Delete GTT Trigger
```bash
curl -X DELETE "https://api.kite.trade/gtt/triggers/GTT_ID" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```

---

## 6. Mutual Funds

### Get MF Orders
```bash
curl -X GET "https://api.kite.trade/mf/orders" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```

### Get Single MF Order
```bash
curl -X GET "https://api.kite.trade/mf/orders/ORDER_ID" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```

### Place MF Order
```bash
curl -X POST "https://api.kite.trade/mf/orders" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "tradingsymbol=INF174K01LS2" \
  -d "transaction_type=BUY" \
  -d "amount=5000" \
  -d "tag=myapp"
```
> For SELL orders, use `quantity` instead of `amount`.

**Response:**
```json
{
  "status": "success",
  "data": { "order_id": "XXXXXXXX" }
}
```

### Cancel MF Order
```bash
curl -X DELETE "https://api.kite.trade/mf/orders/ORDER_ID" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```

---

### Get MF Holdings
```bash
curl -X GET "https://api.kite.trade/mf/holdings" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```
**Response:**
```json
{
  "status": "success",
  "data": [
    {
      "tradingsymbol": "INF174K01LS2",
      "fund": "Kotak Standard Multicap Fund - Growth",
      "folio": "123456/01",
      "quantity": 100.234,
      "average_price": 48.50,
      "last_price": 52.00,
      "last_price_date": "2024-01-01",
      "pnl": 350.00
    }
  ]
}
```

---

### Get MF Allotments
```bash
curl -X GET "https://api.kite.trade/mf/allotments" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```

---

### Get All SIPs
```bash
curl -X GET "https://api.kite.trade/mf/sips" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```

### Get Single SIP
```bash
curl -X GET "https://api.kite.trade/mf/sips/SIP_ID" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```

### Create SIP
```bash
curl -X POST "https://api.kite.trade/mf/sips" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "tradingsymbol=INF174K01LS2" \
  -d "amount=5000" \
  -d "instalments=12" \
  -d "frequency=monthly" \
  -d "instalment_day=5" \
  -d "tag=myapp"
```
> **frequency values:** `weekly` | `monthly` | `quarterly`
> **instalments:** number of instalments (-1 = perpetual)

**Response:**
```json
{
  "status": "success",
  "data": {
    "sip_id": "XXXXXXXX",
    "order_id": "YYYYYYYY"
  }
}
```

### Modify SIP
```bash
curl -X PUT "https://api.kite.trade/mf/sips/SIP_ID" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "amount=7500" \
  -d "frequency=monthly" \
  -d "instalment_day=10" \
  -d "instalments=24" \
  -d "status=active"
```
> **status values:** `active` | `paused`

### Cancel SIP
```bash
curl -X DELETE "https://api.kite.trade/mf/sips/SIP_ID" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```

---

### Get MF Instruments (full list of tradable MF schemes)
```bash
curl -X GET "https://api.kite.trade/mf/instruments" \
  -H "X-Kite-Version: 3" \
  -H "Authorization: token zvzunhd71pl2vkzm:ACCESS_TOKEN"
```
> Returns a CSV dump of all mutual fund schemes available to trade. Use `tradingsymbol` from this list when placing MF orders/SIPs.

---

## Quick Reference — HTTP Methods

| Endpoint | Method | Auth needed |
|---|---|---|
| `/session/token` | POST | api_key + checksum only |
| `/session/token` | DELETE | Yes |
| `/user/profile` | GET | Yes |
| `/user/margins` | GET | Yes |
| `/user/margins/{segment}` | GET | Yes |
| `/portfolio/holdings` | GET | Yes |
| `/portfolio/positions` | GET | Yes |
| `/portfolio/positions` | PUT | Yes |
| `/orders` | GET | Yes |
| `/orders/{variety}` | POST | Yes |
| `/orders/{variety}/{id}` | PUT | Yes |
| `/orders/{variety}/{id}` | DELETE | Yes |
| `/orders/{id}/trades` | GET | Yes |
| `/trades` | GET | Yes |
| `/gtt/triggers` | GET | Yes |
| `/gtt/triggers` | POST | Yes |
| `/gtt/triggers/{id}` | GET | Yes |
| `/gtt/triggers/{id}` | PUT | Yes |
| `/gtt/triggers/{id}` | DELETE | Yes |
| `/mf/orders` | GET | Yes |
| `/mf/orders` | POST | Yes |
| `/mf/orders/{id}` | GET | Yes |
| `/mf/orders/{id}` | DELETE | Yes |
| `/mf/allotments` | GET | Yes |
| `/mf/holdings` | GET | Yes |
| `/mf/sips` | GET | Yes |
| `/mf/sips` | POST | Yes |
| `/mf/sips/{id}` | GET | Yes |
| `/mf/sips/{id}` | PUT | Yes |
| `/mf/sips/{id}` | DELETE | Yes |
| `/mf/instruments` | GET | Yes |

---

## Error Response Format

All errors from Kite follow this shape:
```json
{
  "status": "error",
  "message": "Invalid `api_key` or `access_token`.",
  "error_type": "TokenException",
  "data": null
}
```

**Common error types:**

| error_type | HTTP | Meaning |
|---|---|---|
| `TokenException` | 403 | Invalid or expired access_token |
| `UserException` | 403 | Account issue |
| `TwoFAException` | 403 | 2FA required |
| `OrderException` | 400 | Bad order params |
| `InputException` | 400 | Missing/invalid input |
| `DataException` | 502 | Kite upstream error |
| `NetworkException` | 503 | Kite unreachable |
| `GeneralException` | 500 | Unknown error |

---

## Not Available on Free Plan

These require the **₹500/month** paid plan:
- `GET /quote` — live quotes / LTP
- `GET /quote/ohlc` — OHLC data
- `GET /quote/ltp` — last traded price
- `GET /instruments` — full instrument list with tokens
- `GET /historical/{instrument_token}/{interval}` — historical candle data
- WebSocket market data stream (`wss://ws.kite.trade`)
