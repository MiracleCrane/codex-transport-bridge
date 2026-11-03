"""Prepare/apply/restore one root TOML key; never print the config or credentials."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import tomllib
from urllib.parse import urlparse

KEY = "openai_base_url"
LINE = re.compile(rb"(?m)^[ \t]*(?:#[ \t]*)?(?:openai_base_url|\"openai_base_url\"|'openai_base_url')[ \t]*=.*(?:\r?\n|$)")


class ConfigError(ValueError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def parse(data):
    return tomllib.loads(data.decode("utf-8-sig"))


def write_if_unchanged(path, expected, data):
    """Hold an exclusive Windows handle during compare-and-write; keep the ACL."""
    if os.name != "nt":
        raise ConfigError("This configuration transaction is Windows-only")
    import msvcrt
    path.parent.mkdir(parents=True, exist_ok=True)
    create = ctypes.WinDLL("kernel32", use_last_error=True).CreateFileW
    create.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
                       ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    create.restype = ctypes.c_void_p
    # OPEN_EXISTING, or CREATE_NEW so a concurrently created file is not replaced.
    handle = create(str(path), 0xC0000000, 0, None, 3 if path.exists() else 1, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise OSError(ctypes.get_last_error(), "Cannot exclusively commit config")
    fd = msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
    with os.fdopen(fd, "r+b") as stream:
        current = stream.read()
        if digest(current) != expected:
            raise ConfigError("Config changed before commit; no overwrite")
        try:
            stream.seek(0)
            stream.write(data)
            stream.truncate()
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            stream.seek(0)
            stream.write(current)
            stream.truncate()
            stream.flush()
            raise


def change_key(data, value, original_line=None):
    before = parse(data)
    expected = dict(before)
    if value is None:
        expected.pop(KEY, None)
    else:
        expected[KEY] = value
    newline = b"\r\n" if b"\r\n" in data else b"\n"
    replacement = original_line if original_line is not None else (
        b"" if value is None else f"{KEY} = {json.dumps(value)}".encode() + newline)
    bom = 3 if data.startswith(b"\xef\xbb\xbf") else 0
    for match in LINE.finditer(data[bom:]):
        candidate = data[:bom + match.start()] + replacement + data[bom + match.end():]
        try:
            if parse(candidate) == expected:
                return candidate, match.group()
        except (ValueError, UnicodeError):
            pass
    if KEY not in before and value is not None:
        prefix = b"\xef\xbb\xbf" if data.startswith(b"\xef\xbb\xbf") else b""
        candidate = prefix + replacement + data[len(prefix):]
        if parse(candidate) == expected:
            return candidate, b""
    if before == expected:
        return data, b""
    raise ConfigError("Unsupported TOML layout; config left unchanged")


def validate_url(value):
    u = urlparse(value)
    if (u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost", "::1")
            or not u.port or u.username or u.password or u.query or u.fragment
            or u.path != "/backend-api/codex"):
        raise ConfigError("Only an explicit local bridge base URL is supported")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("prepare", "apply", "restore", "inspect"))
    parser.add_argument("--state", required=True)
    parser.add_argument("--config")
    parser.add_argument("--url")
    args = parser.parse_args()
    state_path = Path(args.state).resolve()
    if args.action == "prepare":
        if not args.config or not args.url:
            parser.error("prepare requires --config and --url")
        if state_path.exists():
            raise ConfigError("Config transaction already exists")
        validate_url(args.url)
        config = Path(args.config).resolve()
        existed = config.exists()
        before = config.read_bytes() if existed else b""
        previous = parse(before).get(KEY)
        if previous is not None:
            validate_url(previous)
        after, old_line = change_key(before, args.url)
        state_path.parent.mkdir(parents=True, exist_ok=True)
        before_path = state_path.with_name("config.before.toml")
        after_path = state_path.with_name("config.after.toml")
        before_path.write_bytes(before)
        after_path.write_bytes(after)
        state = {"config": str(config), "existed": existed, "before": str(before_path),
                 "after": str(after_path), "beforeSha256": digest(before),
                 "afterSha256": digest(after), "previous": previous, "url": args.url,
                 "originalLineHex": old_line.hex(), "status": "prepared"}
        state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    else:
        state = json.loads(state_path.read_text(encoding="utf-8-sig"))
        config = Path(state["config"])
        data = config.read_bytes() if config.exists() else b""
        if args.action == "inspect":
            effective = parse(data)
            print(json.dumps({"ownsSetting": effective.get(KEY) == state["url"], "hasBaseUrl": KEY in effective}))
            return
        if args.action == "apply":
            if parse(data).get(KEY) == state["url"] and state["status"] == "applied":
                print(json.dumps({"status": "already_applied"}))
                return
            if digest(data) != state["beforeSha256"]:
                raise ConfigError("Config changed after preparation; reprepare without overwriting it")
            after = Path(state["after"]).read_bytes()
            if digest(after) != state["afterSha256"]:
                raise ConfigError("Prepared config hash mismatch")
            write_if_unchanged(config, state["beforeSha256"], after)
            state["status"] = "applied"
        else:
            if state["status"] == "restored":
                print(json.dumps({"status": "already_restored"}))
                return
            if parse(data).get(KEY) != state["url"]:
                print(json.dumps({"status": "not_owned", "configChanged": False}))
                return
            before = Path(state["before"]).read_bytes()
            if digest(before) != state["beforeSha256"]:
                raise ConfigError("Config backup hash mismatch")
            if digest(data) == state["afterSha256"]:
                restored = before
            else:
                restored, _ = change_key(data, state["previous"],
                                         bytes.fromhex(state["originalLineHex"]))
            write_if_unchanged(config, digest(data), restored)
            state["status"] = "restored"
        state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": state["status"], "onlySetting": KEY}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Parser errors can include config source text. Output only our bounded
        # diagnostic categories, never exception reprs from arbitrary libraries.
        safe = str(exc) if isinstance(exc, ConfigError) else type(exc).__name__
        print(json.dumps({"status": "failed", "error": safe}))
        raise SystemExit(1)
