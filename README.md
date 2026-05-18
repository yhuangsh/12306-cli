# 12306-cli

中国铁路12306命令行工具 — 搜索车次、在线订票、查询订单

China Railway 12306 CLI — search, book, and manage train tickets from the terminal.

## Features

- 🔍 **Train Search** — Search trains with real-time seat availability
- 🎫 **Book Tickets** — Place orders with seat type and position selection
- 👥 **Multi-Passenger** — Book for multiple passengers in one order
- 📋 **Order Management** — Check unpaid orders and cancel
- 🔐 **Persistent Session** — Browser stays alive between commands via CDP, no startup overhead

## Install

```bash
npm install -g yhuangsh/12306-cli
```

This installs the `12306-cli` command and downloads a Chromium browser (via [Playwright](https://playwright.dev/)) used to automate the 12306 website.

**Requirements:** Node.js ≥ 18

The browser session runs Chromium as a background process. First launch takes a few seconds; subsequent commands reconnect instantly.

## First-Time Setup

Configure your 12306 credentials before booking:

```bash
12306-cli config set username <your_username>
12306-cli config set password <your_password>
12306-cli config set id_last4 <last_4_digits_of_id_card>
```

Optionally set defaults for frequent routes:

```bash
12306-cli config set passenger "张三"
12306-cli config set from 北京
12306-cli config set to 上海
12306-cli config list    # verify
```

## Quick Start

```bash
# Start a persistent browser session
12306-cli session start
# → SMS sent to your phone
12306-cli session start --sms-code 123456
# → Session started. Browser running in background.

# Search trains (no login needed)
12306-cli search --from 北京 --to 上海 --date 2026-06-15

# Book a ticket
12306-cli book --from 北京 --to 上海 --date 2026-06-15 \
  --train G35 --passenger 张三 --seat-type 二等座 --seat-pos F --yes

# Stop the session when done
12306-cli session stop
```

## Commands

## SMS Login

Login is handled by `session start`:

```bash
# Phase 1: send SMS
12306-cli session start
# → { needSmsCode: true, message: "SMS sent..." }

# Phase 2: submit code
12306-cli session start --sms-code 123456
# → { ok: true, message: "Session started..." }
```

The browser stays alive in the background. All subsequent commands reconnect via CDP — zero startup overhead.

### `12306-cli cities`

Show supported city/station names. Use the Chinese name with `--from` and `--to`.

```bash
# List popular cities with their stations
12306-cli cities

# Search by name, pinyin, or station code
12306-cli cities --filter 北京
12306-cli cities -f shanghai
```

### `12306-cli session`

Manage the persistent browser session. The browser stays alive between commands — no startup overhead.

```bash
# Phase 1: launch browser + send SMS
12306-cli session start

# Phase 2: submit SMS code
12306-cli session start --sms-code 123456

# Check status
12306-cli session status

# Kill browser
12306-cli session stop
```

### `12306-cli search`

Search trains. Returns JSON with train codes, times, durations, and seat availability.

```bash
12306-cli search --from 北京 --to 上海 --date 2026-06-15

# Filter by train prefix (e.g. high-speed only)
12306-cli search --from 北京 --to 上海 --date 2026-06-15 --train-filter G
```

Search does not require login.

### `12306-cli book`

Book a ticket. Resolves params from **CLI flags > env vars > config profile > interactive prompt**.

```bash
# Fully specified (zero prompts)
12306-cli book --from 北京 --to 上海 --date 2026-06-15 \
  --train G35 --passenger 张三 --seat-type 二等座 --seat-pos F --yes

# Multi-passenger
12306-cli book --from 北京 --to 上海 --date 2026-06-15 \
  --train G35 --passenger "张三,李四" --seat-type 二等座 --seat-pos "F,D" --yes

# With config defaults set (no need to repeat passenger/route)
12306-cli book --date 2026-06-15 --train G35 --yes
```

**Seat types:** 二等座, 一等座, 特等座, 商务座

**Seat positions:** A=window-left, B=middle, C=aisle-left, D=aisle-right, F=window-right

Seat selection only available on high-speed (G) trains. For D/Z/T/K trains, seat position is auto-assigned by 12306.

The `--yes` flag is required to confirm the order. Without it, the command returns an error.

### `12306-cli orders`

Check orders. Requires login.

```bash
# Unpaid orders (default)
12306-cli orders

# Paid but not yet traveled
12306-cli orders --type upcoming
```

### `12306-cli cancel`

Cancel an unpaid order.

```bash
12306-cli cancel
```

### `12306-cli config`

Manage configuration profiles.

```bash
12306-cli config set username myname       # set a value
12306-cli config set passenger "张三"
12306-cli config get passenger              # get a value
12306-cli config list                       # show all values (secrets masked)
12306-cli config path                       # show config file path
```

Keys: `username`, `password`, `id_last4`, `passenger`, `from`, `to`, `seat_type`, `seat_pos`

## SMS Login

Login is handled by `session start`:

```bash
# Phase 1: send SMS
12306-cli session start
# → { needSmsCode: true, message: "SMS sent..." }

# Phase 2: submit code
12306-cli session start --sms-code 123456
# → { ok: true, message: "Session started..." }
```

The browser stays alive in the background. All subsequent commands reconnect via CDP — zero startup overhead.

Run `12306-cli session stop` to end the session.

## How It Works

Uses [Playwright](https://playwright.dev/) Chromium to drive the 12306 website. The CLI automates the real browser session — page UI interactions (click, select, submit) handle internal state that raw API calls cannot replicate.

Search uses XHR interception for clean structured data. Booking drives the page's own JS functions. Orders are created in **unpaid** state — complete payment on the [12306 website](https://www.12306.cn) or app.

## Notes

- **Maintenance window:** 1:00–6:00 AM CST daily (booking blocked)
- **One unpaid order** at a time
- **Seat row** is auto-assigned by 12306 (not selectable via web)
- **Max ~3 cancels/day** before lockout
- Set `CHROME_PATH` env var to use a custom browser instead of Playwright's Chromium

## License

MIT
