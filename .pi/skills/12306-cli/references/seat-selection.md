# Seat Selection

Seat position selection is available **only for high-speed G-trains**. For D/Z/T/K trains, seat position is auto-assigned by 12306 and the `--seat-pos` flag has no effect.

## Seat Position Codes

| Code | Description |
|------|-------------|
| A | Window-left (靠窗左) |
| B | Middle (中间) |
| C | Aisle-left (过道左) |
| D | Aisle-right (过道右) |
| F | Window-right (靠窗右) |

## Single Passenger

```bash
12306-cli book ... --passenger 张三 --seat-pos F
```

## Multi-Passenger

Each passenger gets their own seat position, matching the passenger order:

```bash
12306-cli book ... --passenger "张三,李四" --seat-pos "F,D"
# 张三 → seat F (window-right)
# 李四 → seat D (aisle-right)
```

The seat row is passenger index: passenger 1 → row 1 in the dialog, passenger 2 → row 2.

## How It Works

12306's seat selection is DOM-based, not API-based. The dialog appears on the passenger confirmation page after clicking "提交订单" (Submit Order). The CLI drives the page UI to select seats — it dispatches mouse events on the seat anchor elements (`<a id="1F">`, `<a id="2F">`, etc.), which 12306 requires (regular `.click()` is blocked).

## Limitations

- **Seat row** is auto-assigned by 12306 backend — you cannot pick a specific carriage or row
- **D/Z/T/K trains** do not support seat selection via the web interface
- Some trains may not show the seat dialog at all (depends on `canChooseSeats` variable)
