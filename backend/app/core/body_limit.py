"""A ceiling on request bodies.

No proxy in front is assumed, and FastAPI reads a multipart body (spooling it
to a temporary file) before a route's sign-in check runs. Without a ceiling,
anyone who can reach the port could stream an upload of any size into
temporary storage. The largest legitimate body is a 10 MB statement
(``STATEMENT_MAX_BYTES`` in ``app/core/uploads.py``), so 30 MB leaves room for
the multipart framing and refuses nothing real.
"""
from starlette.types import ASGIApp, Message, Receive, Scope, Send

MAX_BODY_BYTES = 30 * 1024 * 1024


class _TooLarge(Exception):
    pass


async def _refuse(send: Send) -> None:
    body = b'{"detail":"The request is too large."}'
    await send({
        "type": "http.response.start",
        "status": 413,
        "headers": [(b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode())],
    })
    await send({"type": "http.response.body", "body": body})


class BodyLimitMiddleware:
    """Refuse a body over ``max_bytes``: at once when ``Content-Length`` says
    so, and part-way through when a chunked body runs past it."""

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    too_big = int(value) > self.max_bytes
                except ValueError:
                    too_big = True
                if too_big:
                    await _refuse(send)
                    return

        seen = 0
        started = False

        async def capped_receive() -> Message:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_bytes:
                    raise _TooLarge
            return message

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, capped_receive, tracking_send)
        except _TooLarge:
            if not started:
                await _refuse(send)
