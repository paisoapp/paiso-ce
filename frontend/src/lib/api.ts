const BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

let _accessToken: string | null = null;
let _onUnauthorized: (() => void) | null = null;
let _onForcedAction: ((action: "password" | "mfa") => void) | null = null;

export function setAccessToken(token: string | null) {
  _accessToken = token;
}

export function getAccessToken() {
  return _accessToken;
}

export function setUnauthorizedHandler(fn: () => void) {
  _onUnauthorized = fn;
}

/** Called when the server 403s with password_change_required / mfa_enrollment_required. */
export function setForcedActionHandler(fn: (action: "password" | "mfa") => void) {
  _onForcedAction = fn;
}

class ApiError extends Error {
  /** Plain-language messages keyed by field name, from a 422's `loc`, so a
   *  form can put each one beside its box. Empty for other errors. */
  public fields: Record<string, string>;

  constructor(
    public status: number,
    public detail: string,
    fields: Record<string, string> = {},
  ) {
    super(detail);
    this.name = "ApiError";
    this.fields = fields;
  }
}

type ValidationItem = { loc?: unknown[]; msg?: unknown; type?: unknown; ctx?: Record<string, unknown> };

function fieldName(item: ValidationItem): string | undefined {
  const loc = item.loc;
  if (!Array.isArray(loc)) return undefined;
  const field = loc.filter((x) => typeof x === "string" && x !== "body").pop();
  return typeof field === "string" ? field : undefined;
}

function fieldLabel(field: string | undefined): string {
  if (!field) return "This value";
  const label = field.replace(/_/g, " ").replace(/\bpct\b/, "percentage");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

/** One pydantic validation error as a sentence a person can act on.
 *
 *  Our own validators already phrase a full sentence ("Date of birth can't be
 *  in the future."), so their "Value error, " prefix is dropped. The generic
 *  constraint messages ("Input should be greater than or equal to 0") are
 *  reworded with the field's name and the limit. */
function validationMessage(item: ValidationItem): string {
  const msg = String(item.msg ?? "");
  if (msg.startsWith("Value error, ")) return msg.slice("Value error, ".length);
  if (msg.startsWith("value is not a valid email address"))
    return "Enter a valid email address, like name@example.com.";
  const label = fieldLabel(fieldName(item));
  const ctx = item.ctx ?? {};
  switch (item.type) {
    case "missing":
      return `${label} is required.`;
    case "greater_than_equal":
      return `${label} must be ${ctx.ge} or more.`;
    case "greater_than":
      return `${label} must be more than ${ctx.gt}.`;
    case "less_than_equal":
      return `${label} must be ${ctx.le} or less.`;
    case "less_than":
      return `${label} must be less than ${ctx.lt}.`;
    case "int_parsing":
    case "int_from_float":
    case "float_parsing":
    case "decimal_parsing":
      return `${label} must be a number.`;
    case "date_parsing":
    case "date_from_datetime_parsing":
      return `${label} must be a valid date.`;
    case "string_too_short":
      return ctx.min_length === 1 ? `${label} cannot be empty.` : `${label} must be at least ${ctx.min_length} characters.`;
    case "string_too_long":
      return `${label} must be ${ctx.max_length} characters or fewer.`;
    case "literal_error":
    case "enum":
      return `Choose one of the options for ${label.toLowerCase()}.`;
  }
  return label === "This value" ? msg : `${label}: ${msg}`;
}

/** Field → message for a 422 body, for forms that show errors inline. */
function fieldErrors(detail: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(detail)) return out;
  for (const d of detail as ValidationItem[]) {
    const f = fieldName(d);
    if (f && !out[f]) out[f] = validationMessage(d);
  }
  return out;
}

/**
 * Turn an error body's `detail` into one readable sentence.
 *
 * FastAPI's request validation answers 422 with a *list* of
 * `{loc, msg, type}` objects, and a few endpoints return a structured object;
 * every caller renders `err.detail` as text, so either used to surface as
 * "[object Object]".
 */
function detailText(detail: unknown, fallback: string): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = (detail as ValidationItem[]).map(validationMessage).filter(Boolean);
    return parts.length ? parts.join(" ") : fallback;
  }
  if (detail && typeof detail === "object") {
    const o = detail as Record<string, unknown>;
    const msg = o.message ?? o.display_message ?? o.error_message ?? o.detail;
    if (typeof msg === "string") return msg;
  }
  return fallback;
}

// Silent refresh: access tokens are short-lived; on a 401 we redeem the
// httponly paiso_refresh cookie once and retry the original request. Concurrent
// 401s share a single in-flight refresh.
let _refreshPromise: Promise<boolean> | null = null;

/** One refresh at a time across every tab of this browser.
 *
 *  The server rotates the refresh cookie on each use and treats a second use
 *  of the old one as theft: it ends the session. The access token is held in
 *  memory only, so every tab redeems the cookie when it loads. Two tabs
 *  loading together, as when a browser restores its windows, would otherwise
 *  both send the same cookie and sign the person out. With the lock the
 *  second tab waits and sends the cookie the first one was just given. */
function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks ? (locks.request("paiso-auth-refresh", fn) as Promise<T>) : fn();
}

async function tryRefresh(): Promise<boolean> {
  if (!_refreshPromise) {
    _refreshPromise = (async () => {
      try {
        const res = await withRefreshLock(() =>
          fetch(`${BASE}/auth/refresh`, { method: "POST", credentials: "include" }),
        );
        if (!res.ok) return false;
        const data = await res.json();
        if (data.access_token) {
          _accessToken = data.access_token;
          _onTokenRefreshed?.(data.access_token);
          return true;
        }
        return false;
      } catch {
        return false;
      } finally {
        setTimeout(() => {
          _refreshPromise = null;
        }, 0);
      }
    })();
  }
  return _refreshPromise;
}

/** Get an access token for a page that has just loaded.
 *
 *  The token is never written to storage, so a reload starts without one.
 *  The refresh cookie, which scripts cannot read, is redeemed for a new one
 *  before the app draws. Resolves false when there is no session to restore. */
export function restoreSession(): Promise<boolean> {
  return _accessToken ? Promise.resolve(true) : tryRefresh();
}

let _onTokenRefreshed: ((token: string) => void) | null = null;

/** Called after a silent refresh succeeds so the auth store can persist it. */
export function setTokenRefreshedHandler(fn: (token: string) => void) {
  _onTokenRefreshed = fn;
}

const SIGN_IN_PATHS = new Set(["/auth/login"]);

/** The browser's UTC offset, so the server counts "today" as the user's own
 *  day, not UTC's, which is already tomorrow on an American evening. Minutes as Date.getTimezoneOffset gives them. */
function clockHeaders(): Record<string, string> {
  return { "X-Timezone-Offset": String(new Date().getTimezoneOffset()) };
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: RequestInit,
  isRetry = false,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...clockHeaders(),
  };
  if (_accessToken) {
    headers["Authorization"] = `Bearer ${_accessToken}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: "include",
    body: body != null ? JSON.stringify(body) : undefined,
    ...options,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    if (res.status === 401) {
      // Auth endpoints 401 for their own reasons; don't refresh-loop on them.
      // /auth/me is the exception: it is a plain signed-in read, and the
      // session check polls it, so an expired access token there must try a
      // refresh like any other read and not sign the person out.
      const refreshable = !path.startsWith("/auth/") || path === "/auth/me";
      if (!isRetry && refreshable && (await tryRefresh())) {
        return request<T>(method, path, body, options, true);
      }
      // A sign-in 401 is a wrong password or a missing 2FA code, not an
      // expired session. The page that asked shows it.
      if (_onUnauthorized && !SIGN_IN_PATHS.has(path)) _onUnauthorized();
    }
    if (res.status === 403 && _onForcedAction) {
      if (err.detail === "password_change_required") _onForcedAction("password");
      else if (err.detail === "mfa_enrollment_required") _onForcedAction("mfa");
    }
    throw new ApiError(res.status, detailText(err.detail, res.statusText), fieldErrors(err.detail));
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function uploadFile<T>(path: string, formData: FormData, isRetry = false): Promise<T> {
  const headers: Record<string, string> = { ...clockHeaders() };
  if (_accessToken) {
    headers["Authorization"] = `Bearer ${_accessToken}`;
  }
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    credentials: "include",
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    if (res.status === 401) {
      // The same single retry a JSON request gets; a FormData body can be sent again.
      if (!isRetry && (await tryRefresh())) return uploadFile<T>(path, formData, true);
      if (_onUnauthorized) _onUnauthorized();
    }
    throw new ApiError(res.status, detailText(err.detail, res.statusText), fieldErrors(err.detail));
  }
  return res.json() as Promise<T>;
}

/** A file from the API, saved to the computer under the server's name.
 *
 *  A plain link to an API route cannot work: the browser sends no
 *  Authorization header with it, and the access token lives only in memory.
 *  This fetches with the token (and the same one retry after a refresh that
 *  every other request gets), then hands the bytes to a temporary link with
 *  a `download` attribute. */
async function downloadFile(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  fallbackName = "download",
  isRetry = false,
): Promise<void> {
  const headers: Record<string, string> = { ...clockHeaders() };
  if (body != null) headers["Content-Type"] = "application/json";
  if (_accessToken) headers["Authorization"] = `Bearer ${_accessToken}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: "include",
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    if (res.status === 401) {
      if (!isRetry && (await tryRefresh())) {
        return downloadFile(method, path, body, fallbackName, true);
      }
      if (_onUnauthorized) _onUnauthorized();
    }
    throw new ApiError(res.status, detailText(err.detail, res.statusText), fieldErrors(err.detail));
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filenameFrom(res.headers.get("content-disposition")) ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: some browsers start the save after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The file name in a Content-Disposition header: the RFC 5987 `filename*`
 *  form when present (it carries non-ASCII names), else the plain one. */
function filenameFrom(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // Fall through to the plain name.
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(header);
  return plain ? plain[1].trim() : null;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),
  upload: <T>(path: string, formData: FormData) => uploadFile<T>(path, formData),
  download: (method: "GET" | "POST", path: string, body?: unknown, fallbackName?: string) =>
    downloadFile(method, path, body, fallbackName),
};

export { ApiError };
