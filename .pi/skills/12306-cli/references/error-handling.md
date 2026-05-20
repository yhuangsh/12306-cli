# Error Handling Patterns

All 12306-cli commands return JSON with an `ok` boolean. Agents MUST check this field and handle errors appropriately.

## Response Patterns

### Success
```json
{ "ok": true, ... }
```
Command completed successfully. The remaining fields depend on the command.

### General Error
```json
{ "ok": false, "error": "description" }
```
Something went wrong. Show the error description to the user.

### Session Needed
```json
{ "ok": false, "needLogin": true, "message": "No active session. Run: 12306-cli session start" }
```
The browser session has expired or was never started. **Agent action:** run `session start`, handle SMS flow, retry the original command.

### SMS Code Needed
```json
{ "ok": false, "needSmsCode": true, "message": "SMS sent. Re-run: 12306-cli session start --sms-code <code>" }
```
The SMS code was sent but needs to be submitted. **Agent action:** ask the user for the 6-digit code, then run `session start --sms-code <code>`.

### Maintenance Window
```json
{ "ok": false, "error": "12306 maintenance window (1:00–6:00 AM CST)..." }
```
12306 is in its daily maintenance window. Booking is unavailable. **Agent action:** tell the user to wait until after 6:00 AM CST.

### Booking Blocked (No Confirmation)
```json
{ "ok": false, "error": "Missing --yes or --auto. Confirm with user before placing order." }
```
The `book` command requires `--yes` (user confirmed) or `--auto` (automated). **Agent action:** confirm with the user before adding `--yes`.

### Passenger Not Found
```json
{ "ok": false, "error": "Passenger \"张三\" not found. Available: 张三, 李四, ..." }
```
The passenger name doesn't match any saved passengers in the 12306 account. **Agent action:** show the available names to the user and retry with a valid name.

### Train Not Found
```json
{ "ok": false, "error": "Train G35 not found." }
```
The specified train code wasn't found in search results. **Agent action:** run `search` again and use a valid train code from the results.

### Cancel Failed
```json
{ "ok": false, "error": "Cancel button not found. May need to cancel via app." }
```
The 12306 website doesn't expose a cancel button for this order type. **Agent action:** tell the user to cancel from the 12306 mobile app.

## Agent Decision Flow

```
Run command
  ↓
Check ok field
  ↓
ok === false?
  ├─ needLogin?    → session start → handle SMS → retry
  ├─ needSmsCode?  → ask user for code → session start --sms-code <code> → retry
  ├─ error?        → show to user, don't retry automatically
  └─ other?        → show to user

ok === true?
  → present results to user
```

## Non-TTY Mode

When stdin is not a TTY (pipe, agent, cron), interactive prompts are blocked. All required parameters must be provided as CLI flags or config defaults. Missing parameters will use empty/default values rather than blocking.
