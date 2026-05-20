# Multi-Passenger Booking

Book tickets for multiple passengers in a single order.

## Syntax

```bash
12306-cli book ... \
  --passenger "name1,name2,name3" \
  --seat-pos "F,D,A" \
  --yes
```

Passengers and seat positions are matched 1:1 by position:
- `--passenger "张三,李四"` → 张三 is first, 李四 is second
- `--seat-pos "F,D"` → 张三 gets seat F, 李四 gets seat D

## How It Works

1. After selecting the train, the CLI reaches the passenger confirmation page
2. Passenger checkboxes are clicked one at a time with delays
3. Each passenger gets a separate `#seatType_N` dropdown (1-indexed)
4. In the seat dialog, passenger 1 selects from row 1, passenger 2 from row 2, etc.
5. If a passenger name is not found in the account's saved passengers, the CLI returns an error with available names

## Configuration

Set a default passenger list:

```bash
12306-cli config set passenger "张三,李四"
12306-cli config set seat_pos "F,D"
```

Then book with just route + train:

```bash
12306-cli book --from 北京 --to 上海 --date 2026-06-15 --train G35 --yes
```

## Agent Notes

- The CLI returns available passenger names on error — use this list to provide valid names
- If `--passenger` is omitted, interactive prompt appears (not ideal for agents — always specify it)
- If `--seat-pos` is omitted, interactive prompt asks for each passenger's position individually
