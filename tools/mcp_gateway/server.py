#!/usr/bin/env python3
"""HTTP gateway exposing Maurice MCP tools over Streamable HTTP."""

from __future__ import annotations

import argparse
import importlib
import logging
import os
import secrets
import sys
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncContextManager, Callable, Optional

import uvicorn
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Mount, Route

import mcp.types as types
from mcp.server.lowlevel.server import Server as MCPServer
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.mcp_gateway.oauth import OAuthMiddleware, build_oauth_routes
from tools.shared.context import member_id_var


class MemberContextMiddleware:
    """Extract X-Maurice-Member-Id header and set contextvar for downstream stores."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope.get("headers", []))
            mid = headers.get(b"x-maurice-member-id", b"").decode()
            token = member_id_var.set(mid or None)
            try:
                await self.app(scope, receive, send)
            finally:
                member_id_var.reset(token)
        else:
            await self.app(scope, receive, send)


class TrailingSlashRewriteMiddleware:
    """Rewrite POST/DELETE to base path without trailing slash to include it.

    Starlette Mount matches with trailing slash but MCP clients like
    Claude.ai POST without it.  This middleware transparently adds the
    trailing slash so the Mount catches the request.
    """

    def __init__(self, app, base_path: str) -> None:
        self.app = app
        self.base_path = base_path

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] == "http"
            and scope["path"] == self.base_path
            and scope.get("method", "GET") in {"POST", "DELETE"}
        ):
            scope = dict(scope, path=self.base_path + "/")
        await self.app(scope, receive, send)


class RequestLogMiddleware(BaseHTTPMiddleware):
    """Log every incoming request at DEBUG level for diagnostics."""

    async def dispatch(self, request: Request, call_next):
        logging.getLogger("maurice.gateway").info(
            ">>> %s %s (auth=%s)",
            request.method,
            request.url.path,
            "yes" if request.headers.get("authorization") else "no",
        )
        return await call_next(request)


class BearerAuthMiddleware(BaseHTTPMiddleware):
    """Reject requests missing a valid Bearer token."""

    def __init__(self, app, token: str) -> None:
        super().__init__(app)
        self.token = token

    async def dispatch(self, request: Request, call_next):
        if request.url.path == "/healthz":
            return await call_next(request)
        auth = request.headers.get("authorization", "")
        if not secrets.compare_digest(auth, f"Bearer {self.token}"):
            return PlainTextResponse("Unauthorized", status_code=401)
        return await call_next(request)


@dataclass
class ToolSpec:
    """Definition for a single MCP tool exposed via HTTP."""

    name: str
    context_factory: Callable[[], AsyncContextManager[Any]]
    server_getter: Callable[[Any], MCPServer]


class UnifiedMCPServer:
    """Single MCP server that aggregates tools from multiple sub-servers."""

    def __init__(self) -> None:
        self.app = MCPServer("maurice")
        self._sub_servers: dict[str, MCPServer] = {}
        self._register()

    def add(self, name: str, server: MCPServer) -> None:
        self._sub_servers[name] = server

    def _register(self) -> None:
        @self.app.list_tools()
        async def list_tools() -> list[Any]:
            all_tools: list[Any] = []
            for prefix, sub in self._sub_servers.items():
                handler = sub.request_handlers.get(types.ListToolsRequest)
                if handler is None:
                    continue
                result = await handler(None)
                # result is ServerResult wrapping ListToolsResult
                tools_result = result.root
                for tool in tools_result.tools:
                    tool = tool.model_copy(update={"name": f"{prefix}__{tool.name}"})
                    all_tools.append(tool)
            return all_tools

        @self.app.call_tool()
        async def call_tool(
            name: str, arguments: dict[str, Any] | None
        ) -> list[Any]:
            if "__" not in name:
                return [types.TextContent(type="text", text=f"Unknown tool: {name}. Use 'server__tool' format.")]
            prefix, tool_name = name.split("__", 1)
            sub = self._sub_servers.get(prefix)
            if sub is None:
                return [types.TextContent(type="text", text=f"Unknown server: {prefix}")]
            handler = sub.request_handlers.get(types.CallToolRequest)
            if handler is None:
                return [types.TextContent(type="text", text=f"Server {prefix} has no call_tool handler")]
            req = types.CallToolRequest(
                method="tools/call",
                params=types.CallToolRequestParams(name=tool_name, arguments=arguments),
            )
            result = await handler(req)
            # result is ServerResult wrapping CallToolResult
            call_result = result.root
            return types.CallToolResult(
                content=call_result.content,
                structuredContent=getattr(call_result, "structuredContent", None),
                isError=call_result.isError,
            )


# ── Tool discovery ───────────────────────────────────────────────────────
#
# The gateway mounts whatever MCP tools are present on disk under tools/ — it
# hard-codes no tool name. A public checkout ships only the tools in this repo
# (e.g. garden); a private overlay drops further tool dirs into tools/ and they
# are picked up automatically. Each tool conforms to one of three shapes, tried
# in order:
#   1. a `gateway_context` callable (an async CM yielding a low-level Server) —
#      for tools that own setup/teardown or resolve their own config;
#   2. a module-level `app` (a low-level Server) — mounted directly;
#   3. a module-level `mcp` (a FastMCP) — its `_mcp_server` is mounted.
# A dir matching none of these isn't a gateway tool and is skipped.

# Dirs under tools/ that are infrastructure, not gateway-exposable MCP tools.
_NON_TOOL_DIRS = {"shared", "mcp_gateway"}


def _resolve_tool_spec(name: str) -> Optional[ToolSpec]:
    """Build a ToolSpec for a tool dir, or None if it isn't a gateway tool.

    Raises if the dir *is* a gateway tool whose module fails to import (e.g. a
    missing dependency), so the caller can log it loudly rather than silently
    dropping a tool that was meant to load.
    """
    module = None
    for mod_name in (f"tools.{name}.server", f"tools.{name}.mcp_server"):
        try:
            module = importlib.import_module(mod_name)
            break
        except ModuleNotFoundError as exc:
            if exc.name == mod_name:
                continue  # this entrypoint doesn't exist; try the next shape
            raise  # a dependency *inside* the module is missing — surface it

    if module is None:
        return None

    # 1. explicit hook — the tool owns its setup/teardown and config
    factory = getattr(module, "gateway_context", None)
    if callable(factory):
        return ToolSpec(name=name, context_factory=factory, server_getter=lambda s: s)

    # 2. a low-level Server exposed as `app`
    app = getattr(module, "app", None)
    if isinstance(app, MCPServer):
        @asynccontextmanager
        async def _ctx(_app=app):
            yield _app

        return ToolSpec(name=name, context_factory=_ctx, server_getter=lambda s: s)

    # 3. a FastMCP exposed as `mcp`
    mcp_app = getattr(module, "mcp", None)
    if mcp_app is not None and hasattr(mcp_app, "_mcp_server"):
        @asynccontextmanager
        async def _ctx(_mcp=mcp_app):
            yield _mcp

        return ToolSpec(name=name, context_factory=_ctx, server_getter=lambda m: m._mcp_server)

    return None


def discover_tool_specs() -> list[ToolSpec]:
    """Discover gateway-exposable MCP tools from the tools/ dir on disk."""
    tools_dir = REPO_ROOT / "tools"
    specs: list[ToolSpec] = []
    for entry in sorted(tools_dir.iterdir()):
        name = entry.name
        if not entry.is_dir() or name in _NON_TOOL_DIRS or name[0] in {".", "_"}:
            continue
        try:
            spec = _resolve_tool_spec(name)
        except Exception:
            logging.warning("Tool %r present but failed to load — skipping", name, exc_info=True)
            continue
        if spec is not None:
            specs.append(spec)
        else:
            logging.debug("Dir %r is not a gateway tool — skipping", name)
    logging.info("Discovered MCP tools: %s", ", ".join(s.name for s in specs) or "(none)")
    return specs


def _normalize_base_path(value: str) -> str:
    value = value.strip()
    if not value:
        return "/"
    if not value.startswith("/"):
        value = "/" + value
    return value.rstrip("/") or "/"


def build_app(
    base_path: str,
    corpus_config: Optional[Path] = None,
    auth_token: Optional[str] = None,
    oauth: bool = False,
) -> Starlette:
    # A tool that resolves its own config (e.g. corpus) reads MAURICE_CORPUS_CONFIG;
    # keep the legacy --corpus-config flag working by surfacing it through the env.
    if corpus_config is not None:
        os.environ.setdefault("MAURICE_CORPUS_CONFIG", str(corpus_config))
    specs = discover_tool_specs()
    unified = UnifiedMCPServer()
    manager_holder: list[StreamableHTTPSessionManager] = []
    # Per-server managers for individual endpoints: name -> manager
    per_server_managers: dict[str, StreamableHTTPSessionManager] = {}

    normalized_base = _normalize_base_path(base_path)

    async def root_handler(request):
        server_names = [s.name for s in specs]
        return JSONResponse({
            "endpoint": normalized_base,
            "servers": server_names,
            "per_server_endpoints": {
                name: f"{normalized_base}/{name}/mcp" for name in server_names
            },
        })

    index_paths = {"/"}
    if normalized_base not in {"/", ""}:
        index_paths.add(normalized_base)
        index_paths.add(f"{normalized_base}/")

    routes: list[Any] = []

    # /healthz — lightweight liveness probe (no auth)
    async def healthz_handler(request: Request):
        return JSONResponse({"status": "ok", "service": "mcp-gateway"})
    routes.append(Route("/healthz", healthz_handler, methods=["GET"]))

    # OAuth routes first so they take precedence
    if oauth:
        routes.extend(build_oauth_routes())

    # Root "/" discovery
    if normalized_base not in {"/", ""}:
        routes.append(Route("/", root_handler, methods=["GET"]))
    # GET base path discovery (explicit Route, matches without trailing slash)
    if normalized_base not in {"/", ""}:
        routes.append(Route(normalized_base, root_handler, methods=["GET"]))

    # Per-server MCP endpoints: /{base}/{server_name}/mcp
    for spec in specs:
        server_name = spec.name

        def _make_per_server_asgi(name: str):
            async def asgi(scope, receive, send):
                if scope["type"] != "http":
                    response = PlainTextResponse("Unsupported scope", status_code=400)
                    await response(scope, receive, send)
                    return
                mgr = per_server_managers.get(name)
                if not mgr:
                    response = PlainTextResponse("Server initializing", status_code=503)
                    await response(scope, receive, send)
                    return
                await mgr.handle_request(scope, receive, send)
            return asgi

        routes.append(Mount(f"{normalized_base}/{server_name}", app=_make_per_server_asgi(server_name)))

    # Unified MCP endpoint
    async def mcp_asgi(scope, receive, send):
        if scope["type"] != "http":
            response = PlainTextResponse("Unsupported scope", status_code=400)
            await response(scope, receive, send)
            return
        if not manager_holder:
            response = PlainTextResponse("Server initializing", status_code=503)
            await response(scope, receive, send)
            return
        await manager_holder[0].handle_request(scope, receive, send)

    routes.append(Mount(normalized_base, app=mcp_asgi))


    async def lifespan(app):
        async with AsyncExitStack() as stack:
            for spec in specs:
                instance = await stack.enter_async_context(spec.context_factory())
                server = spec.server_getter(instance)
                unified.add(spec.name, server)
                # Create per-server manager
                mgr = StreamableHTTPSessionManager(server)
                await stack.enter_async_context(mgr.run())
                per_server_managers[spec.name] = mgr
            # Unified manager (must come after sub-servers are added)
            manager = StreamableHTTPSessionManager(unified.app)
            await stack.enter_async_context(manager.run())
            manager_holder.append(manager)
            yield

    middleware = [Middleware(RequestLogMiddleware)]
    if oauth:
        # NOTE: deliberately do NOT add the base path to open_paths. The MCP
        # endpoint lives at the base path, so opening it would bypass OAuth and
        # leave member data unauthenticated. Only the OAuth/discovery/healthz
        # routes in OPEN_PATHS are public; everything else requires a token.
        from tools.mcp_gateway.oauth import OPEN_PATHS
        middleware.append(Middleware(OAuthMiddleware, open_paths=OPEN_PATHS))
    elif auth_token:
        middleware.append(Middleware(BearerAuthMiddleware, token=auth_token))

    app = Starlette(routes=routes, lifespan=lifespan, middleware=middleware)
    app = MemberContextMiddleware(app)
    # Wrap with trailing-slash rewrite so POST to base path reaches the Mount
    if normalized_base not in {"/", ""}:
        app = TrailingSlashRewriteMiddleware(app, normalized_base)
    return app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Maurice MCP HTTP gateway")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8710, help="Port to bind (default: 8710)")
    parser.add_argument(
        "--base-path",
        default="/",
        help="Base HTTP path prefix for all tools (default: /)",
    )
    parser.add_argument(
        "--corpus-config",
        type=Path,
        help="Optional override path for corpus config YAML",
    )
    parser.add_argument(
        "--require-auth",
        action="store_true",
        default=False,
        help="Require Bearer token auth (reads MAURICE_MCP_TOKEN env var)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")

    auth_token = None
    use_oauth = False

    if args.require_auth:
        # If MAURICE_OAUTH_PASSWORD is set, use OAuth mode; otherwise bearer token
        oauth_password = os.environ.get("MAURICE_OAUTH_PASSWORD") or os.environ.get("AKITA_OAUTH_PASSWORD")
        if oauth_password:
            use_oauth = True
            logging.info("OAuth 2.1 auth enabled")
        else:
            auth_token = os.environ.get("MAURICE_MCP_TOKEN") or os.environ.get("AKITA_MCP_TOKEN")
            if not auth_token:
                logging.error(
                    "--require-auth set but neither MAURICE_OAUTH_PASSWORD nor MAURICE_MCP_TOKEN env var is set"
                )
                sys.exit(1)
            logging.info("Bearer token auth enabled")

    app = build_app(args.base_path, args.corpus_config, auth_token=auth_token, oauth=use_oauth)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
