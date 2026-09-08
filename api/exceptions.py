"""Domain exceptions used by gateways and services.

Routers are responsible for translating these into HTTP responses.
"""

from __future__ import annotations


class DomainError(Exception):
    """Base class for all domain errors."""

    def __init__(self, code: str, message: str, details: list[str] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or []


class NotFoundError(DomainError):
    """Requested resource does not exist."""

    def __init__(self, code: str, message: str):
        super().__init__(code, message)


class ConflictError(DomainError):
    """Resource already exists or operation conflicts with current state."""

    def __init__(self, code: str, message: str):
        super().__init__(code, message)


class ValidationError(DomainError):
    """Input validation failed."""

    def __init__(self, code: str, message: str, details: list[str] | None = None):
        super().__init__(code, message, details)


class ProcessingError(DomainError):
    """Processing failed for an internal reason."""

    def __init__(self, code: str, message: str):
        super().__init__(code, message)


class AuthenticationError(DomainError):
    """User is not authenticated or credentials are invalid."""

    def __init__(self, code: str, message: str):
        super().__init__(code, message)


class PermissionError(DomainError):
    """Authenticated user lacks permission for the operation."""

    def __init__(self, code: str, message: str):
        super().__init__(code, message)
