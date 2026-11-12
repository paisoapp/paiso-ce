"""Security headers the app sends itself.

Paiso serves the web app and the API from one process with no proxy in
front that it can count on, so it sets these headers itself, on every
response:

- ``nosniff`` stops a browser from treating an uploaded file as HTML or script
  whatever its ``Content-Type`` says.
- The Content-Security-Policy allows scripts, styles, fonts, images and
  requests from the app itself only. ``style-src`` keeps
  ``'unsafe-inline'`` because the charts and several components set style
  attributes; injected styles cannot run code. ``frame-ancestors 'none'`` is
  the modern form of ``X-Frame-Options: DENY``, which is sent too for older
  browsers.
- ``Permissions-Policy`` denies features nothing in the app uses.

HSTS is left to the HTTPS proxy a self-hoster puts in front, which knows
whether the whole domain is HTTPS.
"""

_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    # The two outside image hosts are where the asset photo lookups point:
    # Wikipedia for a vehicle, Zillow for a home. Scripts and fetches stay
    # same-origin.
    "font-src 'self' data:; "
    "img-src 'self' data: blob: https://upload.wikimedia.org https://photos.zillowstatic.com; "
    "connect-src 'self'; "
    "worker-src 'self' blob:; manifest-src 'self'; frame-ancestors 'none'; "
    "base-uri 'self'; form-action 'self'; object-src 'none'"
)

_HEADERS = (
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"strict-origin-when-cross-origin"),
    (b"x-frame-options", b"DENY"),
    (b"content-security-policy", _CSP.encode()),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=(), payment=()"),
)


class SecurityHeadersMiddleware:
    """Adds ``_HEADERS`` to every HTTP response that does not already set
    them (pure ASGI, so it also covers streaming and file responses)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers") or [])
                present = {name.lower() for name, _ in headers}
                headers.extend(h for h in _HEADERS if h[0] not in present)
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)
