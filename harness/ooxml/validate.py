"""Open XML validation of PPTX files (a measuring device for the writer's output).

    python -m harness.ooxml.validate <pptx>... [--private]

prints one JSON line per file: {"file": <basename>, "errors": [{"id", "part", "path", "description"}]}. With --private
it prints only {"file": null, "errorCount": n, "ids": [...]}: no file name and no description, because a description
can quote attribute values from a private deck. Exit 0: every file has 0 errors; 1: some file has errors; 3: the
validator cannot run (no dotnet, build failed).

The C# project (Validator/) is built once into out/ooxml-validator/<hash>/ and reused until Program.cs or the .csproj
changes; concurrent callers wait on a lock file (out/ooxml-validator.lock) instead of racing.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PROJECT = HERE / "Validator"
BUILD_ROOT = ROOT / "out" / "ooxml-validator"
LOCK = ROOT / "out" / "ooxml-validator.lock"
# A lock older than this was left by a build that crashed. It is longer than a waiter's whole wait (and a cold build), so
# that a process waiting on a build that is still running never takes its lock away (final review, ledger L49).
LOCK_STALE_SECONDS = 900
LOCK_WAIT_SECONDS = 600
DONE = "build.ok"


class ValidatorUnavailable(RuntimeError):
    pass


def _source_hash() -> str:
    digest = hashlib.sha256()
    for name in ("Validator.csproj", "Program.cs"):
        digest.update(name.encode() + b"\0" + (PROJECT / name).read_bytes() + b"\0")
    return digest.hexdigest()


def _built_dll(wanted: str) -> Path | None:
    # Each source hash has a directory of its own that is written once and never overwritten, so a validation that is
    # running its dll cannot be disturbed by a later build. The marker is written last: no marker, no build.
    directory = BUILD_ROOT / wanted[:16]
    dll = directory / "Validator.dll"
    return dll if dll.exists() and (directory / DONE).exists() else None


def _acquire_lock() -> None:
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + LOCK_WAIT_SECONDS
    while True:
        try:
            os.close(os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            return
        except FileExistsError:
            try:
                if time.time() - LOCK.stat().st_mtime > LOCK_STALE_SECONDS:
                    LOCK.unlink()  # a crashed build left it
                    continue
            except FileNotFoundError:
                continue
            if time.monotonic() > deadline:
                raise ValidatorUnavailable("timed out waiting for the validator build lock")
            time.sleep(0.2)


def ensure_built() -> Path:
    """Build the validator unless a build of these sources exists in out/ooxml-validator/; return the dll path.

    Concurrent callers (parallel tests) queue on an exclusive lock file; the second one finds the finished build."""
    try:
        wanted = _source_hash()
        dll = _built_dll(wanted)
        if dll:
            return dll
        dotnet = shutil.which("dotnet")
        if dotnet is None:
            raise ValidatorUnavailable("dotnet is not installed")
        _acquire_lock()
        try:
            dll = _built_dll(wanted)  # another process may have built it while this one waited
            if dll:
                return dll
            directory = BUILD_ROOT / wanted[:16]
            if directory.exists():
                shutil.rmtree(directory)
            # dotnet's own obj/ stays under Validator/ (git-ignored); only the finished build goes to out/.
            proc = subprocess.run(
                [dotnet, "build", str(PROJECT / "Validator.csproj"), "-c", "Release", "-o", str(directory), "--nologo", "-v", "q"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
            )
            if proc.returncode != 0 or not (directory / "Validator.dll").exists():
                raise ValidatorUnavailable("dotnet build failed:\n" + (proc.stdout + proc.stderr)[-2000:])
            (directory / DONE).write_text(wanted + "\n", encoding="utf-8")
            return directory / "Validator.dll"
        finally:
            try:
                LOCK.unlink()
            except OSError:
                pass
    except ValidatorUnavailable:
        raise
    except Exception as error:  # OSError reading sources or writing the build, and anything unexpected
        raise ValidatorUnavailable(f"build failed: {type(error).__name__}") from None


def validate(paths: list[Path], private: bool = False) -> list[dict]:
    """One result per file: {"file", "errors"}, or with private=True {"file": None, "errorCount", "ids"}.

    Anything that stops the validator from giving a trustworthy answer raises ValidatorUnavailable."""
    paths = [Path(p) for p in paths]
    if not paths:
        return []
    dll = ensure_built()
    dotnet = shutil.which("dotnet")
    if dotnet is None:
        raise ValidatorUnavailable("dotnet is not installed")
    try:
        proc = subprocess.run(
            [dotnet, str(dll), *map(str, paths)], capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
    except Exception as error:
        raise ValidatorUnavailable(f"could not start the validator: {type(error).__name__}") from None
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    if proc.returncode != 0 or len(lines) != len(paths):
        # stderr can name private files; report only that it failed
        raise ValidatorUnavailable(f"validator exited {proc.returncode} with {len(lines)} results for {len(paths)} files")
    try:
        results = [json.loads(line) for line in lines]
        for result in results:
            if not isinstance(result["errors"], list) or not all(isinstance(e["id"], str) for e in result["errors"]):
                raise TypeError
            result["file"]
    except Exception as error:
        raise ValidatorUnavailable(f"unexpected validator output: {type(error).__name__}") from None
    if not private:
        return results
    return [
        {"file": None, "errorCount": len(r["errors"]), "ids": sorted({e["id"] for e in r["errors"]})} for r in results
    ]


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    private = "--private" in args
    files = [a for a in args if a != "--private"]
    if not files:
        print("usage: python -m harness.ooxml.validate <pptx>... [--private]", file=sys.stderr)
        return 3
    try:
        results = validate([Path(f) for f in files], private=private)
        out = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in results)
        sys.stdout.buffer.write(out.encode("utf-8"))
        sys.stdout.flush()
        bad = any((r["errorCount"] if private else len(r["errors"])) for r in results)
    except Exception as error:
        # any failure to validate is exit 3, never 1 ("a file has errors"); private mode prints the type name only
        detail = type(error).__name__ if private or not isinstance(error, ValidatorUnavailable) else str(error)
        print(f"validator unavailable: {detail}", file=sys.stderr)
        return 3
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
