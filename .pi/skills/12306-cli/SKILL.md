---
name: 12306-cli
description: Search and book train tickets on China's 12306 railway system. Use when the user wants to search trains, book tickets, check orders, or cancel orders. Supports seat type and position selection (window/aisle), multi-passenger booking, and order management.
allowed-tools: Bash(12306-cli:*)
---

# 12306 Train Ticket CLI

Command-line tool for searching and booking train tickets on 12306 (中国铁路). All commands output JSON to stdout, diagnostics to stderr.

## First-Time Setup

```bash
12306-cli config set username <your_username>
12306-cli config set password <your_password>
12306-cli config set id_last4 <last_4_digits_of_id_card>
```

Optionally set defaults:

```bash
12306-cli config set passenger "张三"
12306-cli config set from 北京
12306-cli config set to 上海
```

## Core Workflow

### 1. Start a browser session (required for booking/orders/cancel)

```bash
# Phase 1: sends SMS code
12306-cli session start
# → { "ok": false, "needSmsCode": true, "message": "SMS sent..." }

# Phase 2: submit code (after user provides it)
12306-cli session start --sms-code 123456
# → { "ok": true, "message": "Session started..." }
```

The browser stays alive in the background. All subsequent commands reconnect via CDP — zero startup overhead.

### 2. Search trains (no login needed)

```bash
12306-cli search --from 北京 --to 上海 --date 2026-06-15
```

### 3. Book a ticket (requires active session + user confirmation)

```bash
12306-cli book --from 北京 --to 上海 --date 2026-06-15 \
  --train G35 --passenger 张三 --seat-type 二等座 --seat-pos F --yes
```

### 4. Stop the session when done

```bash
12306-cli session stop
```

## SMS Login Protocol (Critical for AI Agents)

The `session start` command uses a **two-phase** SMS flow. The agent must handle this correctly:

1. **Agent** runs `12306-cli session start`
2. If output has `"needSmsCode": true` → **agent asks user** for the 6-digit SMS code
3. **Agent** re-runs `12306-cli session start --sms-code <code>`
4. Session is saved; all subsequent commands work

**Important:** `search` never requires login. `book`, `orders`, `cancel` require an active session.

When the session expires:
```json
{ "ok": false, "needLogin": true, "message": "No active session. Run: 12306-cli session start" }
```

The agent should run `session start` to re-authenticate.

## Booking Confirmation Protocol

**CRITICAL:** Before running `book`, the agent MUST confirm with the user. Show the train details (code, departure, arrival, seat info) and ask for explicit approval.

- `--yes` = agent has confirmed with user (interactive)
- `--auto` = automated/cron booking (no confirmation needed)
- Neither = error (order not placed)

## Command Reference

All options are detailed in `--help`. Key commands:

### search
```bash
12306-cli search --from <city> --to <city> --date <YYYY-MM-DD> [--train-filter G]
```
- No login required
- City names in Chinese: 北京, 上海虹桥, 广州南, etc.
- Output: `{ ok, count, trains: [{ code, fromStation, toStation, departure, arrival, duration, bookable, seats }] }`

### book
```bash
12306-cli book --from <city> --to <city> --date <YYYY-MM-DD> \
  --train <code> --passenger <name> [--passenger "name1,name2"] \
  --seat-type <type> [--seat-pos <letter>] --yes
```
- Requires active session
- Multi-passenger: comma-separated `--passenger` and `--seat-pos`
- Seat types: 二等座, 一等座, 特等座, 商务座
- Seat positions: A=window-left, B=middle, C=aisle-left, D=aisle-right, F=window-right
- Seat selection only available on G-trains
- Output: `{ ok, train, passengers: [...], seatType, seatPos, date, from, to, message }`

### orders
```bash
12306-cli orders [--type upcoming|history]
```
- Requires active session
- `--type upcoming` = paid but not yet traveled
- `--type history` = completed/refunded orders
- Default: unpaid orders
- Output: `{ ok, type, count, orders: [{ sequenceNo, orderDate, amount, tickets: [{ passenger, trainCode, fromStation, toStation, travelDate, seatType, coach, seatNo, price, status }] }] }`

### cancel
```bash
12306-cli cancel
```
- Requires active session
- Note: cancellation may require the 12306 mobile app
- Max ~3 cancels/day before lockout

### cities
```bash
12306-cli cities [--filter <keyword>]
```
- No login required
- Filter by Chinese name, pinyin, or station code

### config
```bash
12306-cli config set <key> <value>
12306-cli config get <key>
12306-cli config list
12306-cli config path
```

### session
```bash
12306-cli session start [--sms-code <code>]
12306-cli session stop
12306-cli session status
```

## Output JSON Reference

### Search success
```json
{ "ok": true, "date": "2026-05-22", "from": "北京", "to": "上海", "count": 54,
  "trains": [{ "code": "G1", "fromStation": "北京南", "toStation": "上海虹桥",
    "departure": "06:30", "arrival": "11:24", "duration": "04:54",
    "bookable": true, "seats": { "二等座": "有", "一等座": "有" } }],
  "source": "api" }
```

### Book success
```json
{ "ok": true, "train": "G1", "passengers": ["张三"],
  "seatType": "二等座", "seatPos": "F",
  "date": "2026-05-22", "from": "北京", "to": "上海",
  "message": "Order placed (not paid). Pay in 12306 app or website." }
```

### Orders upcoming
```json
{ "ok": true, "type": "upcoming", "count": 2,
  "orders": [{ "sequenceNo": "EC97456116", "orderDate": "2026-05-17 19:36:43",
    "amount": "662.00",
    "tickets": [{ "passenger": "张三", "trainCode": "G30",
      "fromStation": "上海虹桥", "toStation": "北京南",
      "travelDate": "2026-05-24", "departure": "18:52", "arrival": "23:21",
      "seatType": "二等座", "coach": "08", "seatNo": "006A",
      "price": "662.00", "status": "已支付" }] }] }
```

### Session expired / not logged in
```json
{ "ok": false, "needLogin": true, "message": "No active session. Run: 12306-cli session start" }
```

### SMS needed
```json
{ "ok": false, "needSmsCode": true, "message": "SMS sent. Re-run: 12306-cli session start --sms-code <code>" }
```

### General error
```json
{ "ok": false, "error": "description" }
```

## Common Patterns

### Pattern 1: Full booking flow
```bash
# 1. Login
12306-cli session start
# → { needSmsCode: true } → ask user for code
12306-cli session start --sms-code 123456

# 2. Search  
12306-cli search --from 北京 --to 上海 --date 2026-06-15

# 3. Confirm with user, then book
12306-cli book --from 北京 --to 上海 --date 2026-06-15 \
  --train G1 --passenger 张三 --seat-type 二等座 --seat-pos F --yes

# 4. Check order
12306-cli orders
```

### Pattern 2: Agent without TTY (scripted/automated)
```bash
# All params must be provided as CLI flags — no interactive prompts
# If session is needed, use --sms-code on session start
12306-cli session start --sms-code 123456
12306-cli book --from 北京 --to 上海 --date 2026-06-15 \
  --train G1 --passenger 张三 --seat-type 二等座 --seat-pos F --yes
```

## Notes

- **Maintenance window:** booking unavailable 1:00–6:00 AM CST daily
- **One unpaid order** at a time — must cancel or pay before booking new tickets
- **Seat row** is auto-assigned by 12306 (not selectable via web)
- **Max ~3 cancels/day** before account lockout
- Search always works without login
- Install: `npm install -g yhuangsh/12306-cli`

## References

- [Seat Selection Details](references/seat-selection.md)
- [Multi-Passenger Booking](references/multi-passenger.md)
- [Error Handling Patterns](references/error-handling.md)
