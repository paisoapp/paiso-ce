import { useRef, useState } from "react";
import { AsYouType, parsePhoneNumberFromString } from "libphonenumber-js";
import { cn } from "@/lib/utils";

/**
 * US phone numbers, formatted as the person types and validated with
 * libphonenumber (Google's metadata): "4155550123" becomes "(415) 555-0123".
 *
 * The backend runs the same library, rejects anything that isn't a real US
 * number, and stores E.164.
 */

const US = "US" as const;

/** "(415) 555-0123" for display, from whatever is stored (E.164 or legacy). */
export function formatPhoneForDisplay(stored: string | null | undefined): string {
  if (!stored) return "";
  const parsed = parsePhoneNumberFromString(stored, US);
  return parsed?.country === US ? parsed.formatNational() : stored;
}

/** A reason the number can't be saved, or null when it's blank or valid. */
export function phoneError(value: string): string | null {
  if (!value.trim()) return null;
  const parsed = parsePhoneNumberFromString(value, US);
  // `isValid()` alone accepts any country's number; this field is US-only.
  if (parsed?.isValid() && parsed.country === US) return null;
  return "Enter a valid US phone number, e.g. (415) 555-0123.";
}

function formatDigits(digits: string): string {
  return digits ? new AsYouType(US).input(digits) : "";
}

/** Index in `text` just after its `n`-th digit (0 → start). */
function caretAfterDigit(text: string, n: number): number {
  if (n <= 0) return text.startsWith("(") ? 1 : 0;
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\d/.test(text[i]) && ++seen === n) return i + 1;
  }
  return text.length;
}

export function PhoneInput({
  id,
  value,
  onChange,
  className,
  placeholder = "(415) 555-0123",
}: {
  id?: string;
  /** The formatted display value, e.g. "(415) 555-0123". */
  value: string;
  onChange: (formatted: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [touched, setTouched] = useState(false);
  const error = touched ? phoneError(value) : null;

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const el = e.target;
    const raw = el.value;
    const caret = el.selectionStart ?? raw.length;
    let digitsBefore = raw.slice(0, caret).replace(/\D/g, "").length;
    let digits = raw.replace(/\D/g, "");

    // Backspace over a "(", ")", " " or "-" removes no digit, and the
    // formatter would put the punctuation straight back — the key would look
    // dead. Treat it as deleting the digit before the caret instead.
    const prevDigits = value.replace(/\D/g, "");
    if (raw.length < value.length && digits === prevDigits && digitsBefore > 0) {
      digits = digits.slice(0, digitsBefore - 1) + digits.slice(digitsBefore);
      digitsBefore -= 1;
    }

    // 10 digits, or 11 with a leading country code 1.
    digits = digits.slice(0, digits.startsWith("1") ? 11 : 10);
    const formatted = formatDigits(digits);
    onChange(formatted);

    // Keep the caret beside the same digit rather than jumping to the end.
    requestAnimationFrame(() => {
      const pos = caretAfterDigit(formatted, Math.min(digitsBefore, digits.length));
      ref.current?.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="space-y-1">
      <input
        ref={ref}
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        value={value}
        onChange={handleChange}
        onBlur={() => setTouched(true)}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error && id ? `${id}-error` : undefined}
        className={cn(className, error && "border-destructive focus-visible:ring-destructive/40")}
      />
      {error && (
        <p id={id ? `${id}-error` : undefined} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
