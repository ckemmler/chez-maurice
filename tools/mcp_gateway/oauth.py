"""OAuth 2.1 implementation for the Maurice MCP gateway.

Single-user-per-token, in-memory OAuth with PKCE support for Claude.ai remote MCP.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.routing import Route

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

OAUTH_PASSWORD = os.environ.get("AKITA_OAUTH_PASSWORD", "")
MAURICE_SERVER_URL = os.environ.get("MAURICE_SERVER_URL", "http://127.0.0.1:3001")

AUTH_CODE_LIFETIME = 600  # 10 minutes (Claude.ai can be slow)
ACCESS_TOKEN_LIFETIME = 3600  # 1 hour
REFRESH_TOKEN_LIFETIME = 30 * 24 * 3600  # 30 days

TEMPLATES_DIR = Path(__file__).parent / "templates"

# ---------------------------------------------------------------------------
# In-memory storage (cleared on restart — Claude.ai simply re-auths)
# ---------------------------------------------------------------------------


@dataclass
class AuthCode:
    code: str
    client_id: str
    redirect_uri: str
    code_challenge: str
    scope: str
    created_at: float = field(default_factory=time.time)
    used: bool = False
    member_id: str = ""


@dataclass
class TokenRecord:
    access_token: str
    refresh_token: str
    client_id: str
    scope: str
    issued_at: float = field(default_factory=time.time)
    expires_in: int = ACCESS_TOKEN_LIFETIME
    member_id: str = ""


# code -> AuthCode
auth_codes: dict[str, AuthCode] = {}
# refresh_token -> TokenRecord
refresh_tokens: dict[str, TokenRecord] = {}
# client_id -> client metadata (from DCR)
registered_clients: dict[str, dict[str, Any]] = {}

# ---------------------------------------------------------------------------
# PKCE helpers
# ---------------------------------------------------------------------------


def _base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def verify_pkce(code_verifier: str, code_challenge: str) -> bool:
    computed = _base64url_encode(hashlib.sha256(code_verifier.encode("ascii")).digest())
    return secrets.compare_digest(computed, code_challenge)


# ---------------------------------------------------------------------------
# Opaque access token storage
# ---------------------------------------------------------------------------

# access_token -> {client_id, scope, created_at, member_id}
access_tokens: dict[str, dict[str, Any]] = {}


def _issue_access_token(client_id: str, scope: str, member_id: str = "") -> str:
    token = secrets.token_hex(32)
    access_tokens[token] = {
        "client_id": client_id,
        "scope": scope,
        "created_at": time.time(),
        "member_id": member_id,
    }
    return token


# maur_* token -> (checked_at, member_id) cache, to avoid an HTTP round-trip
# to the Maurice server on every single MCP request.
_maur_cache: dict[str, tuple[float, str]] = {}
_MAUR_CACHE_TTL = 60  # seconds


def _validate_maurice_token(raw: str) -> str | None:
    """Validate a maur_* token against the Maurice server, returning member_id.

    Cached briefly. Lets the gateway accept member tokens directly (Bearer
    header clients) in addition to OAuth access tokens, so both Claude Desktop's
    custom-connector (OAuth) and raw-Bearer setups work.
    """
    now = time.time()
    hit = _maur_cache.get(raw)
    if hit and now - hit[0] < _MAUR_CACHE_TTL:
        return hit[1] or None
    try:
        # Loopback to the Maurice server, which serves TLS with a cert that may
        # be self-signed/expired behind the tunnel — verify=False is safe here.
        with httpx.Client(timeout=5.0, verify=False) as client:
            resp = client.get(
                f"{MAURICE_SERVER_URL}/api/users/me",
                headers={"Authorization": f"Bearer {raw}"},
            )
        mid = str(resp.json().get("id", "")) if resp.status_code == 200 else ""
    except Exception:
        logger.exception("maur token validation failed")
        return None
    _maur_cache[raw] = (now, mid)
    return mid or None


def _validate_access_token(token: str) -> dict | None:
    # Accept a static internal key for trusted loopback callers (the Maurice
    # server's own agentic tool loop). Such calls carry member scope in the
    # X-Maurice-Member-Id header (handled by MemberContextMiddleware), so the
    # static-key claims intentionally leave member_id empty.
    static_key = (
        os.environ.get("MAURICE_MCP_TOKEN")
        or os.environ.get("AKITA_MCP_TOKEN")
        or OAUTH_PASSWORD
    )
    if static_key and secrets.compare_digest(token, static_key):
        return {"client_id": "_static", "scope": "mcp", "sub": "static-key", "member_id": ""}

    # Member token presented directly as a Bearer (not via OAuth): validate live.
    if token.startswith("maur_"):
        mid = _validate_maurice_token(token)
        if mid:
            return {"client_id": "_maurice", "scope": "mcp", "sub": mid, "member_id": mid}
        return None

    data = access_tokens.get(token)
    if not data:
        return None
    if time.time() - data["created_at"] > ACCESS_TOKEN_LIFETIME:
        access_tokens.pop(token, None)
        return None
    return {
        "client_id": data["client_id"],
        "scope": data["scope"],
        "created_at": data["created_at"],
        "member_id": data.get("member_id", ""),
    }


# ---------------------------------------------------------------------------
# Client credential helpers
# ---------------------------------------------------------------------------


def _verify_client(client_id: str, client_secret: str) -> bool:
    """Verify client credentials against registered clients."""
    client = registered_clients.get(client_id)
    if not client:
        return False
    stored_secret = client.get("client_secret", "")
    if not stored_secret:
        return False
    return secrets.compare_digest(str(client_secret), str(stored_secret))


def _extract_client_credentials(request: Request, body: dict) -> tuple[str, str]:
    """Extract client_id and client_secret from request (Basic auth or POST body)."""
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Basic "):
        try:
            decoded = base64.b64decode(auth_header[6:]).decode("utf-8")
            client_id, client_secret = decoded.split(":", 1)
            return client_id, client_secret
        except Exception:
            pass
    return str(body.get("client_id", "")), str(body.get("client_secret", ""))


# ---------------------------------------------------------------------------
# Endpoint handlers
# ---------------------------------------------------------------------------


def _external_base(request: Request) -> str:
    """Public base URL as seen by the client, honoring reverse-proxy headers.

    Behind the Maurice server / Cloudflare the gateway's own base_url is
    127.0.0.1:8710; the proxy forwards X-Forwarded-Proto/Host so OAuth metadata
    advertises the real https://magik.chezmaurice.eu origin.
    """
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host")
        or request.url.netloc
    )
    return f"{proto}://{host}".rstrip("/")


async def protected_resource_metadata(request: Request) -> JSONResponse:
    """GET /.well-known/oauth-protected-resource"""
    base = _external_base(request)
    # Extract the resource path suffix from the well-known URL if present
    # e.g. /.well-known/oauth-protected-resource/akita/corpus -> /akita/corpus
    path = request.url.path
    prefix = "/.well-known/oauth-protected-resource"
    resource_path = path[len(prefix):] if path.startswith(prefix) else ""
    resource = f"{base}{resource_path}" if resource_path else base

    return JSONResponse({
        "resource": resource,
        "authorization_servers": [base],
        "scopes_supported": ["mcp"],
        "bearer_methods_supported": ["header"],
    })


async def authorization_server_metadata(request: Request) -> JSONResponse:
    """GET /.well-known/oauth-authorization-server"""
    base = _external_base(request)
    return JSONResponse({
        "issuer": base,
        "authorization_endpoint": f"{base}/authorize",
        "token_endpoint": f"{base}/token",
        "registration_endpoint": f"{base}/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "scopes_supported": ["mcp"],
        "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
    })


async def authorize_get(request: Request) -> HTMLResponse:
    """GET /authorize — render consent page."""
    template_path = TEMPLATES_DIR / "authorize.html"
    html = template_path.read_text()

    client_id = request.query_params.get("client_id", "")
    redirect_uri = request.query_params.get("redirect_uri", "")
    state = request.query_params.get("state", "")
    scope = request.query_params.get("scope", "mcp")
    code_challenge = request.query_params.get("code_challenge", "")
    code_challenge_method = request.query_params.get("code_challenge_method", "")

    html = html.replace("{{client_id}}", client_id)
    html = html.replace("{{redirect_uri}}", redirect_uri)
    html = html.replace("{{state}}", state)
    html = html.replace("{{scope}}", scope)
    html = html.replace("{{code_challenge}}", code_challenge)
    html = html.replace("{{code_challenge_method}}", code_challenge_method)

    return HTMLResponse(html)


async def authorize_post(request: Request) -> RedirectResponse | HTMLResponse:
    """POST /authorize — verify Maurice MCP token, issue auth code, redirect."""
    form = await request.form()
    submitted_token = str(form.get("token", ""))
    client_id = form.get("client_id", "")
    redirect_uri = form.get("redirect_uri", "")
    state = form.get("state", "")
    scope = form.get("scope", "mcp")
    code_challenge = form.get("code_challenge", "")

    def _render_error(message: str) -> HTMLResponse:
        template_path = TEMPLATES_DIR / "authorize.html"
        html = template_path.read_text()
        html = html.replace("{{client_id}}", str(client_id))
        html = html.replace("{{redirect_uri}}", str(redirect_uri))
        html = html.replace("{{state}}", str(state))
        html = html.replace("{{scope}}", str(scope))
        html = html.replace("{{code_challenge}}", str(code_challenge))
        html = html.replace("{{code_challenge_method}}", "S256")
        html = html.replace("<!-- ERROR -->", f'<p style="color:red">{message}</p>')
        return HTMLResponse(html, status_code=403)

    if not submitted_token:
        return _render_error("Please enter your Maurice MCP token.")

    # Validate the token against the Maurice server
    member_id = ""
    try:
        async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
            resp = await client.get(
                f"{MAURICE_SERVER_URL}/api/users/me",
                headers={"Authorization": f"Bearer {submitted_token}"},
            )
        if resp.status_code == 200:
            data = resp.json()
            member_id = str(data.get("id", ""))
        else:
            logger.warning("Token validation failed: HTTP %s", resp.status_code)
            return _render_error("Invalid token. Please check your Maurice MCP token.")
    except Exception:
        logger.exception("Error contacting Maurice server for token validation")
        return _render_error("Could not reach the Maurice server. Please try again.")

    if not member_id:
        return _render_error("Invalid token: could not identify member.")

    code = secrets.token_urlsafe(32)
    auth_codes[code] = AuthCode(
        code=code,
        client_id=str(client_id),
        redirect_uri=str(redirect_uri),
        code_challenge=str(code_challenge),
        scope=str(scope),
        member_id=member_id,
    )
    logger.info("Issued auth code for client_id=%s member_id=%s", client_id, member_id)

    sep = "&" if "?" in str(redirect_uri) else "?"
    location = f"{redirect_uri}{sep}code={code}"
    if state:
        location += f"&state={state}"
    return RedirectResponse(url=location, status_code=302)


async def token_endpoint(request: Request) -> JSONResponse:
    """POST /token — exchange code or refresh token for access token."""
    # Support both form-encoded and JSON bodies
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        body = await request.json()
    else:
        form = await request.form()
        body = dict(form)

    grant_type = body.get("grant_type", "")

    # Validate client credentials
    client_id, client_secret = _extract_client_credentials(request, body)
    if not _verify_client(client_id, client_secret):
        logger.warning("Token request with invalid client credentials: client_id=%s", client_id)
        return JSONResponse(
            {"error": "invalid_client", "error_description": "Invalid client credentials"},
            status_code=401,
        )

    if grant_type == "authorization_code":
        return _handle_authorization_code(body, client_id)
    elif grant_type == "refresh_token":
        return _handle_refresh_token(body, client_id)
    else:
        return JSONResponse({"error": "unsupported_grant_type"}, status_code=400)


def _handle_authorization_code(body: dict, client_id: str) -> JSONResponse:
    code_value = body.get("code", "")
    code_verifier = body.get("code_verifier", "")
    redirect_uri = body.get("redirect_uri", "")

    record = auth_codes.get(code_value)
    if not record:
        return JSONResponse({"error": "invalid_grant", "error_description": "Unknown code"}, status_code=400)

    if record.used:
        return JSONResponse({"error": "invalid_grant", "error_description": "Code already used"}, status_code=400)

    if time.time() - record.created_at > AUTH_CODE_LIFETIME:
        return JSONResponse({"error": "invalid_grant", "error_description": "Code expired"}, status_code=400)

    if record.client_id != client_id:
        return JSONResponse({"error": "invalid_grant", "error_description": "client_id mismatch"}, status_code=400)

    if redirect_uri and redirect_uri != record.redirect_uri:
        return JSONResponse({"error": "invalid_grant", "error_description": "redirect_uri mismatch"}, status_code=400)

    if not verify_pkce(code_verifier, record.code_challenge):
        return JSONResponse({"error": "invalid_grant", "error_description": "PKCE verification failed"}, status_code=400)

    record.used = True

    access_token = _issue_access_token(record.client_id, record.scope, record.member_id)
    refresh_tok = secrets.token_urlsafe(48)
    token_record = TokenRecord(
        access_token=access_token,
        refresh_token=refresh_tok,
        client_id=record.client_id,
        scope=record.scope,
        member_id=record.member_id,
    )
    refresh_tokens[refresh_tok] = token_record
    logger.info("Issued tokens for client_id=%s member_id=%s", record.client_id, record.member_id)

    resp = {
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": ACCESS_TOKEN_LIFETIME,
        "refresh_token": refresh_tok,
        "scope": record.scope,
    }
    logger.info("Token response: %s", {k: (v[:20] + "..." if isinstance(v, str) and len(v) > 20 else v) for k, v in resp.items()})
    return JSONResponse(resp, headers={"Cache-Control": "no-store"})


def _handle_refresh_token(body: dict, client_id: str) -> JSONResponse:
    old_refresh = body.get("refresh_token", "")
    record = refresh_tokens.pop(old_refresh, None)

    if not record:
        return JSONResponse({"error": "invalid_grant", "error_description": "Unknown refresh token"}, status_code=400)

    if record.client_id != client_id:
        return JSONResponse({"error": "invalid_grant", "error_description": "client_id mismatch"}, status_code=400)

    if time.time() - record.issued_at > REFRESH_TOKEN_LIFETIME:
        return JSONResponse({"error": "invalid_grant", "error_description": "Refresh token expired"}, status_code=400)

    access_token = _issue_access_token(record.client_id, record.scope, record.member_id)
    new_refresh = secrets.token_urlsafe(48)
    new_record = TokenRecord(
        access_token=access_token,
        refresh_token=new_refresh,
        client_id=record.client_id,
        scope=record.scope,
        member_id=record.member_id,
    )
    refresh_tokens[new_refresh] = new_record
    logger.info("Refreshed tokens for client_id=%s member_id=%s", record.client_id, record.member_id)

    return JSONResponse(
        {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": ACCESS_TOKEN_LIFETIME,
            "refresh_token": new_refresh,
            "scope": record.scope,
        },
        headers={"Cache-Control": "no-store"},
    )


async def register_endpoint(request: Request) -> JSONResponse:
    """POST /register — Dynamic Client Registration."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    client_id = secrets.token_urlsafe(16)
    client_secret = secrets.token_urlsafe(32)

    # Build response — no null values (Claude.ai silently fails on nulls)
    client_meta: dict[str, Any] = {
        "client_id": client_id,
        "client_secret": client_secret,
        "client_id_issued_at": int(time.time()),
        "client_secret_expires_at": 0,  # never expires (required by RFC 7591)
        "redirect_uris": body.get("redirect_uris", []),
        "grant_types": body.get("grant_types", ["authorization_code", "refresh_token"]),
        "response_types": body.get("response_types", ["code"]),
        "token_endpoint_auth_method": "client_secret_post",
        "scope": body.get("scope", "mcp"),
    }

    # Only include client_name if provided
    if body.get("client_name"):
        client_meta["client_name"] = body["client_name"]

    registered_clients[client_id] = client_meta
    logger.info("Registered client: %s (name=%s)", client_id, client_meta.get("client_name", ""))

    return JSONResponse(
        client_meta,
        status_code=201,
        headers={"Cache-Control": "no-store"},
    )


# ---------------------------------------------------------------------------
# Route builder
# ---------------------------------------------------------------------------


def build_oauth_routes() -> list[Route]:
    return [
        Route("/.well-known/oauth-protected-resource", protected_resource_metadata, methods=["GET"]),
        # RFC 9728: path-aware well-known — /.well-known/oauth-protected-resource/akita/corpus
        Route("/.well-known/oauth-protected-resource/{path:path}", protected_resource_metadata, methods=["GET"]),
        Route("/.well-known/oauth-authorization-server", authorization_server_metadata, methods=["GET"]),
        Route("/.well-known/oauth-authorization-server/{path:path}", authorization_server_metadata, methods=["GET"]),
        Route("/authorize", authorize_get, methods=["GET"]),
        Route("/authorize", authorize_post, methods=["POST"]),
        Route("/token", token_endpoint, methods=["POST"]),
        Route("/register", register_endpoint, methods=["POST"]),
    ]


# ---------------------------------------------------------------------------
# OAuth middleware (replaces BearerAuthMiddleware)
# ---------------------------------------------------------------------------

# Paths that don't require authentication
OPEN_PATHS = frozenset({
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/authorize",
    "/token",
    "/register",
    "/healthz",
})


class OAuthMiddleware(BaseHTTPMiddleware):
    """Validate JWT access tokens on MCP routes."""

    def __init__(self, app, open_paths: frozenset[str] | None = None) -> None:
        super().__init__(app)
        self.open_paths = open_paths or OPEN_PATHS

    async def dispatch(self, request: Request, call_next):
        from tools.shared.context import member_id_var

        path = request.url.path

        # Allow open paths, root index, and path-aware well-known URLs (RFC 9728)
        if (
            path in self.open_paths
            or path == "/"
            or path.rstrip("/") == ""
            or path.startswith("/.well-known/oauth-")
        ):
            return await call_next(request)

        # Extract Bearer token
        auth_header = request.headers.get("authorization", "")
        if not auth_header.startswith("Bearer "):
            logger.warning("No Bearer token for %s %s", request.method, path)
            return self._unauthorized(request)

        token = auth_header[7:]
        claims = _validate_access_token(token)
        if claims is None:
            logger.warning("Invalid JWT for %s %s (token prefix: %s...)", request.method, path, token[:20])
            return self._unauthorized(request)

        logger.info("Authenticated %s %s (sub=%s member_id=%s)", request.method, path, claims.get("sub"), claims.get("member_id"))
        # Attach claims to request state for downstream use
        request.state.oauth_claims = claims

        # Set member_id contextvar directly from token claims (bypasses X-Maurice-Member-Id header)
        mid = claims.get("member_id", "")
        if mid:
            token_ctx = member_id_var.set(mid)
            try:
                response = await call_next(request)
            finally:
                member_id_var.reset(token_ctx)
            return response

        return await call_next(request)

    def _unauthorized(self, request: Request) -> JSONResponse:
        base = _external_base(request)
        # Use path-aware well-known URL (RFC 9728) so the resource field
        # matches the actual MCP endpoint Claude.ai is trying to access
        path = request.url.path.rstrip("/")
        resource_url = f"{base}/.well-known/oauth-protected-resource{path}"
        return JSONResponse(
            {"error": "unauthorized"},
            status_code=401,
            headers={
                "WWW-Authenticate": f'Bearer resource_metadata="{resource_url}"',
            },
        )
