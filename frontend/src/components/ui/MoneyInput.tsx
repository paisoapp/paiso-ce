import type { InputHTMLAttributes } from "react";

/** Dollars a person types: under a trillion (the API's limit), to the cent. */
const MAX_WHOLE_DIGITS = 12;

/** Keep what can be part of an amount: digits, one point with at most two
 *  places after it, and a leading minus when the amount may be negative. */
function cleanMoney(raw: string, allowNegative = true): string {
  const negative = allowNegative && raw.trim().startsWith("-");
  const [whole = "", ...rest] = raw.replace(/[^0-9.]/g, "").split(".");
  const cents = rest.join("").slice(0, 2);
  const body = whole.slice(0, MAX_WHOLE_DIGITS) + (rest.length ? `.${cents}` : "");
  return (negative ? "-" : "") + body;
}

/**
 * An amount box. A number input printed a long value back as
 * "-9.99e+19" and let "-5000.129" through; this is a text box with a decimal
 * keypad that keeps the value as typed, to the cent, so it never reformats
 * under the cursor.
 */
export function MoneyInput({
  value,
  onValueChange,
  allowNegative = true,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: string;
  onValueChange: (value: string) => void;
  allowNegative?: boolean;
}) {
  return (
    <input
      {...props}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={value}
      onChange={(e) => onValueChange(cleanMoney(e.target.value, allowNegative))}
    />
  );
}
