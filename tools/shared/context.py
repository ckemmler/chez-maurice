"""Shared context variables for member scoping across MCP tool servers."""

from __future__ import annotations

from contextvars import ContextVar

# Set by MemberContextMiddleware in the MCP gateway when a request arrives
# with the X-Maurice-Member-Id header.  Individual store methods read this
# as a fallback when no explicit member_id is passed.
member_id_var: ContextVar[str | None] = ContextVar("member_id", default=None)


def get_member_id() -> str | None:
    """Return the current member_id from context, or None."""
    return member_id_var.get()


def require_member_id() -> str:
    """Return the current member_id, raising if unset."""
    mid = member_id_var.get()
    if not mid:
        raise RuntimeError("member_id is required but not set in context")
    return mid
