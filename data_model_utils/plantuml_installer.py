"""Auto-install a native PlantUML binary from official GitHub releases.

The module is intentionally dependency-free (stdlib only). It downloads the
correct platform/arch native image archive, verifies its SHA256 digest,
extracts it to ``data_model_utils/vendor/plantuml-native-{system}-{arch}/``,
and returns the absolute path to the executable.

Behaviour is configurable via environment variables:

* ``PLANTUML_VERSION`` (default: ``1.2026.6``)
* ``PLANTUML_CACHE_DIR`` (default: ``<module_dir>/vendor/plantuml-native-{system}-{arch}``)
* ``PLANTUML_SKIP_SHA_CHECK`` (default: ``false``)

The installer is safe to use from multiple Uvicorn workers because it relies
on a disk-based lock file: only one worker downloads the binary, the others
wait for it to finish and reuse the result.
"""

from __future__ import annotations

import hashlib
import os
import platform
import stat
import threading
import time
import urllib.error
import urllib.request
import zipfile
import logging
from pathlib import Path
from typing import Any

# fcntl is Unix-only; Windows falls back to a simple file-based lock.
try:
    import fcntl
except ImportError:
    fcntl = None  # type: ignore[assignment]

_logger = logging.getLogger(__name__)


def _print(msg: str, *args: Any) -> None:
    """Print and log a message so it is visible even without logging setup."""
    formatted = msg % args if args else msg
    print(formatted, flush=True)
    _logger.info(formatted)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_PLANTUML_VERSION = os.getenv("PLANTUML_VERSION", "1.2026.6")

# How long a process will wait for another process to finish downloading.
INSTALL_LOCK_TIMEOUT = float(os.getenv("PLANTUML_INSTALL_TIMEOUT", "180"))

# Mapping (system.lower(), machine.lower()) -> GitHub asset name template.
# The GitHub release page uses these exact asset names for the native images.
_PLATFORM_ASSETS: dict[tuple[str, str], str] = {
    ("linux", "x86_64"): "native-plantuml-linux-amd64-{version}.zip",
    ("linux", "amd64"): "native-plantuml-linux-amd64-{version}.zip",
    ("linux", "aarch64"): "native-plantuml-linux-arm64-{version}.zip",
    ("linux", "arm64"): "native-plantuml-linux-arm64-{version}.zip",
    ("darwin", "arm64"): "native-plantuml-macos-arm64-{version}.zip",
    ("darwin", "aarch64"): "native-plantuml-macos-arm64-{version}.zip",
    ("windows", "amd64"): "native-plantuml-windows-amd64-{version}.zip",
    ("windows", "x86_64"): "native-plantuml-windows-amd64-{version}.zip",
}

# SHA-256 digests for the supported assets (version 1.2026.6). These are
# published on the GitHub release page next to each asset. Keeping them here
# means the installer can verify the download even when running headless.
_KNOWN_SHAS: dict[str, str] = {
    "native-plantuml-linux-amd64-1.2026.6.zip": (
        "835c238634ed1b8638c3fdcfe4f94d005fc9664df3da2c88f80d0aaf4471b04b"
    ),
    "native-plantuml-linux-arm64-1.2026.6.zip": (
        "bacbf79948b48e56397c43f4a5146951b780fadfe391ff46f9eeffff9f962359"
    ),
    "native-plantuml-macos-arm64-1.2026.6.zip": (
        "12222c236aada460e379a694aa6329ea594c0e3eee11aa411665b43c8562bbf2"
    ),
    "native-plantuml-windows-amd64-1.2026.6.zip": (
        "a27961a865880a1a91db77fd196f317128732d668e6e20c4c20dc6f633b32e9f"
    ),
}

# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class PlantUMLInstallError(Exception):
    """Base exception for installation errors."""


class UnsupportedPlatformError(PlantUMLInstallError):
    """Raised when the current platform has no native PlantUML release."""


class DownloadError(PlantUMLInstallError):
    """Raised when the download from GitHub fails."""


class ChecksumError(PlantUMLInstallError):
    """Raised when the downloaded archive digest does not match."""


class LockTimeoutError(PlantUMLInstallError):
    """Raised when waiting for another installer process times out."""


# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------

# Lock used to avoid concurrent downloads from multiple threads of the same
# process. Across Uvicorn workers we rely on a disk lock file instead.
_install_lock = threading.Lock()

# Simple shared status for the current process. It is updated by the
# background install thread and read by the visualisation code to decide
# whether the native binary is ready.
_status: dict[str, Any] = {
    "started": False,
    "finished": False,
    "binary_path": None,
    "error": None,
}


# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------


def _normalize_machine(machine: str) -> str:
    machine = machine.lower()
    if machine in {"x86_64", "amd64", "x64", "intel64"}:
        return "x86_64"
    if machine in {"aarch64", "arm64"}:
        return "arm64"
    return machine


def detect_platform_asset(version: str = DEFAULT_PLANTUML_VERSION) -> tuple[str, str]:
    """Return (asset_name, expected_sha256) for the current platform.

    Raises:
        UnsupportedPlatformError: if no native release exists for this OS/arch.
    """
    system = platform.system().lower()
    machine = _normalize_machine(platform.machine())
    key = (system, machine)
    asset_template = _PLATFORM_ASSETS.get(key)

    if not asset_template:
        raise UnsupportedPlatformError(
            f"No native PlantUML release available for {platform.system()} {platform.machine()}."
        )

    asset_name = asset_template.format(version=version)
    expected_sha = _KNOWN_SHAS.get(asset_name, "")
    return asset_name, expected_sha


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def _module_dir() -> Path:
    return Path(__file__).resolve().parent


def get_default_cache_dir(version: str = DEFAULT_PLANTUML_VERSION) -> Path:
    """Return the default cache directory for the current platform."""
    system = platform.system().lower()
    machine = _normalize_machine(platform.machine())
    return _module_dir() / "vendor" / f"plantuml-native-{system}-{machine}-{version}"


def get_cache_dir(version: str = DEFAULT_PLANTUML_VERSION) -> Path:
    """Return the configured cache directory."""
    env = os.getenv("PLANTUML_CACHE_DIR", "")
    if env.strip():
        return Path(env.strip()).expanduser().resolve()
    return get_default_cache_dir(version)


def _find_binary(cache_dir: Path) -> Path | None:
    """Locate the PlantUML executable inside the cache directory.

    The cache directory is created if it does not already exist.
    """
    system = platform.system().lower()
    executable_name = "plantuml.exe" if system == "windows" else "plantuml"

    # Make sure the cache directory exists before scanning it.
    cache_dir.mkdir(parents=True, exist_ok=True)

    candidate = cache_dir / executable_name
    if candidate.exists():
        # On Unix, verify it is executable.
        if system != "windows":
            if not os.access(candidate, os.X_OK):
                try:
                    candidate.chmod(candidate.stat().st_mode | stat.S_IXUSR)
                except OSError:
                    return None
                if not os.access(candidate, os.X_OK):
                    return None
        return candidate

    # Some archives put the binary in a subdirectory.
    for sub in cache_dir.iterdir():
        if sub.is_dir():
            nested = sub / executable_name
            if nested.exists():
                if system != "windows":
                    if not os.access(nested, os.X_OK):
                        try:
                            nested.chmod(nested.stat().st_mode | stat.S_IXUSR)
                        except OSError:
                            continue
                        if not os.access(nested, os.X_OK):
                            continue
                return nested

    return None


# ---------------------------------------------------------------------------
# Download helpers
# ---------------------------------------------------------------------------


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Cross-process lock file
# ---------------------------------------------------------------------------


def _lock_file_path(version: str = DEFAULT_PLANTUML_VERSION) -> Path:
    return get_cache_dir(version) / ".plantuml-install.lock"


class _DiskLock:
    """A simple cross-process lock based on a file and OS locking primitives.

    On Unix it uses ``fcntl.flock``. On Windows it falls back to a basic
    file-based mutex: opening the lock file in exclusive mode is used as a
    signal. This is good enough because the installer is not a high-contention
    system and the lock is held for minutes at most.
    """

    def __init__(self, lock_path: Path, timeout: float = INSTALL_LOCK_TIMEOUT):
        self.lock_path = lock_path
        self.timeout = timeout
        self._handle: Any | None = None

    def __enter__(self) -> "_DiskLock":
        system = platform.system().lower()
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        start = time.monotonic()
        wait_logged = False

        while True:
            try:
                if system == "windows" or fcntl is None:
                    # Exclusive open, fail immediately if already locked.
                    self._handle = open(self.lock_path, "x")
                else:
                    self._handle = open(self.lock_path, "w")
                    fcntl.flock(self._handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except (OSError, IOError) as e:
                # The lock is held by another process. Wait a bit and retry.
                if self._handle is not None:
                    try:
                        self._handle.close()
                    except Exception:
                        pass
                    self._handle = None

                elapsed = time.monotonic() - start
                if elapsed >= self.timeout:
                    raise LockTimeoutError(
                        f"Timed out after {self.timeout:.0f}s waiting for another "
                        f"PlantUML installer process to finish ({self.lock_path})."
                    ) from e

                if not wait_logged:
                    _print(
                        "[PlantUML] Another worker is installing the native binary; "
                        "waiting up to %.0fs...",
                        self.timeout,
                    )
                    wait_logged = True
                time.sleep(2.0)

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        if self._handle is None:
            return
        try:
            system = platform.system().lower()
            if system != "windows" and fcntl is not None:
                try:
                    fcntl.flock(self._handle, fcntl.LOCK_UN)
                except OSError:
                    pass
            self._handle.close()
        except OSError:
            pass
        finally:
            # Clean up the lock file so future workers see a clean state.
            try:
                self.lock_path.unlink(missing_ok=True)
            except OSError:
                pass
            self._handle = None


def _download_with_progress(url: str, dest: Path, timeout: float = 120.0) -> None:
    """Download ``url`` to ``dest`` with basic progress logging."""
    _print("[PlantUML] Downloading %s -> %s", url, dest)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            total = int(response.headers.get("Content-Length", 0))
            downloaded = 0
            chunk_size = 65536
            with open(dest, "wb") as f:
                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        percent = downloaded * 100 // total
                        if downloaded % (5 * chunk_size) < chunk_size:
                            _print(
                                "[PlantUML] Download progress: %d%% (%d/%d bytes)",
                                percent,
                                downloaded,
                                total,
                            )
    except urllib.error.HTTPError as e:
        raise DownloadError(f"HTTP {e.code} while downloading {url}: {e.reason}") from e
    except urllib.error.URLError as e:
        raise DownloadError(f"Network error while downloading {url}: {e.reason}") from e
    except TimeoutError as e:
        raise DownloadError(f"Timeout while downloading {url}") from e


def download_asset(
    asset_name: str,
    version: str = DEFAULT_PLANTUML_VERSION,
    dest_dir: Path | None = None,
    expected_sha256: str | None = None,
    timeout: float = 120.0,
) -> Path:
    """Download a release asset and verify its SHA256 digest.

    Args:
        asset_name: e.g. ``native-plantuml-linux-amd64-1.2026.6.zip``.
        version: PlantUML release version.
        dest_dir: Where to save the archive. Defaults to ``PLANTUML_CACHE_DIR``.
        expected_sha256: Optional digest to verify.
        timeout: Network timeout in seconds.

    Returns:
        Path to the downloaded archive.

    Raises:
        DownloadError: on network/HTTP failure.
        ChecksumError: when the digest does not match.
    """
    if dest_dir is None:
        dest_dir = get_cache_dir(version)

    dest_dir.mkdir(parents=True, exist_ok=True)
    archive_path = dest_dir / asset_name

    url = f"https://github.com/plantuml/plantuml/releases/download/v{version}/{asset_name}"

    # If the archive already exists and checks out, reuse it.
    if archive_path.exists() and expected_sha256 and not _skip_sha_check():
        if _sha256_file(archive_path) == expected_sha256:
            _print("[PlantUML] Reusing cached archive %s", archive_path)
            return archive_path
        else:
            _print("[PlantUML] Cached archive digest mismatch, re-downloading.")

    _download_with_progress(url, archive_path, timeout=timeout)

    if expected_sha256 and not _skip_sha_check():
        actual = _sha256_file(archive_path)
        if actual != expected_sha256:
            archive_path.unlink(missing_ok=True)
            raise ChecksumError(
                f"Digest mismatch for {asset_name}: expected {expected_sha256}, got {actual}."
            )

    return archive_path


def extract_archive(archive_path: Path, cache_dir: Path) -> None:
    """Extract the zip archive into ``cache_dir``."""
    _print("[PlantUML] Extracting %s to %s", archive_path, cache_dir)
    try:
        with zipfile.ZipFile(archive_path, "r") as zf:
            zf.extractall(cache_dir)
    except zipfile.BadZipFile as e:
        raise PlantUMLInstallError(f"Invalid zip archive {archive_path}: {e}") from e


# ---------------------------------------------------------------------------
# Main installer entrypoint
# ---------------------------------------------------------------------------


def _skip_sha_check() -> bool:
    return os.getenv("PLANTUML_SKIP_SHA_CHECK", "false").lower() in {"true", "1", "yes"}


def install_native_plantuml(
    version: str = DEFAULT_PLANTUML_VERSION,
) -> Path | None:
    """Download, verify and extract PlantUML native binary for this platform.

    Returns the path to the executable, or ``None`` if the platform is not
    supported or if the installation fails.
    """
    global _status

    try:
        asset_name, expected_sha = detect_platform_asset(version)
        cache_dir = get_cache_dir(version)

        # Maybe we already have it extracted from a previous run.
        existing = _find_binary(cache_dir)
        if existing:
            _print("[PlantUML] Found existing binary at %s", existing)
            _status["binary_path"] = existing
            _status["finished"] = True
            return existing

        archive_path = download_asset(
            asset_name,
            version=version,
            dest_dir=cache_dir,
            expected_sha256=expected_sha or None,
        )

        extract_archive(archive_path, cache_dir)

        binary = _find_binary(cache_dir)
        if not binary:
            raise PlantUMLInstallError(
                f"Could not find plantuml executable in {cache_dir} after extraction."
            )

        _print("[PlantUML] Native binary ready at %s", binary)
        _status["binary_path"] = binary
        _status["finished"] = True
        return binary

    except UnsupportedPlatformError as e:
        _print("[PlantUML] %s", e)
        _status["error"] = str(e)
        _status["finished"] = True
        return None
    except LockTimeoutError as e:
        _print("[PlantUML] %s", e)
        _status["error"] = str(e)
        _status["finished"] = True
        return None
    except Exception as e:
        _print(
            "[PlantUML] Installation failed for %s: %s", get_cache_dir(version), e
        )
        _status["error"] = str(e)
        _status["finished"] = True
        return None


def get_binary_path() -> Path | None:
    """Return the installed binary path, or ``None`` if not (yet) available."""
    return _status.get("binary_path")


def is_install_finished() -> bool:
    """Return ``True`` if the background install attempt has completed."""
    return _status.get("finished", False)


def is_install_started() -> bool:
    """Return ``True`` if the background install has been started."""
    return _status.get("started", False)


def start_background_install(version: str = DEFAULT_PLANTUML_VERSION) -> threading.Thread:
    """Start a daemon thread that installs PlantUML in the background.

    The installer uses a disk-based lock so that only one Uvicorn worker
    actually downloads the binary. Other workers wait for the lock, then reuse
    the binary if installation succeeded or mark themselves finished if it failed.

    The thread is non-blocking. Visualisation code should poll
    ``get_binary_path()`` and fall back to web servers if it returns ``None``.
    """
    global _status

    def _target() -> None:
        cache_dir = get_cache_dir(version)

        # If the binary is already present, use it and skip the lock entirely.
        existing = _find_binary(cache_dir)
        if existing:
            _print("[PlantUML] Native binary already available at %s", existing)
            _status["binary_path"] = existing
            _status["finished"] = True
            return

        with _DiskLock(_lock_file_path(version), timeout=INSTALL_LOCK_TIMEOUT):
            # Re-check after acquiring the lock: another worker may have finished.
            existing = _find_binary(cache_dir)
            if existing:
                _print("[PlantUML] Native binary already available at %s", existing)
                _status["binary_path"] = existing
                _status["finished"] = True
                return

            _print("[PlantUML] Installing native binary for this platform...")
            install_native_plantuml(version)

    with _install_lock:
        # Avoid starting multiple threads inside the same process.
        if _status["started"]:
            return threading.Thread(target=lambda: None, daemon=True)
        _status["started"] = True

    thread = threading.Thread(target=_target, daemon=True, name="plantuml-installer")
    thread.start()
    return thread
