---
name: 12306-booking
description: Search and book train tickets on China's 12306 railway system. Use when the user wants to search trains, book tickets, check orders, or cancel orders on 12306. Supports seat type and position selection (window/aisle), multi-train search with filtering, and order management.
metadata:
  openclaw:
    emoji: "🚄"
    requires:
      bins: ["node"]
    install:
      - id: npm-deps
        kind: npm
        label: Install Playwright
        hint: cd SKILL_DIR/scripts && npm install playwright
---

# 12306 Train Ticket Booking

## Installation

When this skill is first loaded or the user sends a tarball/zip containing this skill:

1. **Extract** (if tarball/zip): extract to `~/.openclaw/workspace/skills/12306-booking/`
2. **Install deps**: run `cd <skill-dir>/scripts && npm install`
3. **Check for config**: look for `~/.config/12306-booking/default` or `~/.config/12306-booking/profiles/personal.conf`
   - If exists with `TRAIN_USERNAME`, `TRAIN_PASSWORD`, `TRAIN_ID_LAST4` → setup done
   - If missing → **ask the user** for these 3 values, then create profile:
     ```bash
     mkdir -p ~/.config/12306-booking/profiles ~/.config/12306-booking/sessions
     cat > ~/.config/12306-booking/profiles/personal.conf << 'EOF'
     TRAIN_USERNAME="<username>"
     TRAIN_PASSWORD="<password>"
     TRAIN_ID_LAST4="<last4>"
     EOF
     ln -sf personal.conf ~/.config/12306-booking/default
     ```
4. **Verify**: run `node <skill-dir>/scripts/booking.js search --from 北京 --to 上海 --date 2099-01-01` and check output
5. Report ready to user

After install, `SKILL_DIR` below refers to the installed skill directory (typically `~/.openclaw/workspace/skills/12306-booking`).

## Commands

```bash
SCRIPT=~/.openclaw/workspace/skills/12306-booking/scripts/booking.js
```

All output JSON to stdout. Progress on stderr.

### Search Trains

```bash
node $SCRIPT search --from 北京 --to 上海 --date 2026-05-22
```

Returns `{"ok": true, "trains": [{"code", "departure", "arrival", "duration", "bookable", ...}]}`

### Book a Ticket

**IMPORTANT:** Before running `book`, the agent MUST confirm with the user. Show the train details (code, departure, arrival, price) and ask for explicit approval. Do not place orders without user confirmation.

```bash
node $SCRIPT book --from 北京 --to 上海 --date 2026-05-22 --train G35 --passenger 张三 --seat-type 二等座 --seat-pos F --yes
```

- `--yes` = agent has confirmed with user (required for interactive booking)
- `--auto` = automated/recurring booking, skip confirmation (for cron jobs)

**Seat types:** 二等座, 一等座, 特等座, 商务座
**Seat positions:** A=window-left, B=middle, C=aisle-left, D=aisle-right, F=window-right

### Check Unpaid Orders

```bash
node $SCRIPT orders
```

### Cancel Unpaid Order

```bash
node $SCRIPT cancel
```

## SMS Login Protocol

When session expires, the script returns `{"needSmsCode": true}`. Follow this protocol:

1. Run command normally
2. If output has `"needSmsCode": true` → ask user for the 6-digit SMS code
3. Re-run same command appending `--sms-code <code>`
4. Session saved, results returned

**Note:** `search` never requires login.

## Booking Confirmation Protocol

**IMPORTANT:** Before running `book`, the agent MUST confirm with the user. Show the train details (code, departure, arrival, price) and ask for explicit approval.

- `--yes` = agent has confirmed with user (interactive)
- `--auto` = automated/cron booking (no confirmation needed)
- Neither = error (order not placed)

The agent should confirm *before* calling `book --yes`, not after. The `--yes` flag certifies the agent already has user approval.

## Notes

- Maintenance window: 1:00–6:00 AM daily
- One unpaid order at a time
- Row auto-assigned by 12306 (not selectable via web)
- Max ~3 cancels/day before lockout
- `--headless false` to show browser
