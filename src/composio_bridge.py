#!/usr/bin/env python3
"""One-shot, stdin-to-stdout bridge from the Buzz MCP plugin to Composio CLI.

The CLI owns authentication. This script never accepts a shell command or a
program path from the model; it only builds fixed Composio subcommands.
"""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

COMPOSIO = (
    os.environ.get("COMPOSIO_BIN")
    or shutil.which("composio")
    or str(Path.home() / ".local" / "bin" / "composio")
)
MAX_RESULT = 240_000
SLUG = re.compile(r"^[A-Z][A-Z0-9_]{1,150}$")
TOOLKIT = re.compile(r"^[a-z][a-z0-9_]{1,80}$")


def cli(args, data=None):
    if not Path(COMPOSIO).is_file():
        raise RuntimeError("Composio CLI is unavailable. Install and sign in to composio, then restart Buzz.")
    completed = subprocess.run(
        [COMPOSIO, *args],
        input=data,
        text=True,
        capture_output=True,
        timeout=90,
        check=False,
    )
    output = completed.stdout.strip()
    if len(output) > MAX_RESULT:
        output = output[:MAX_RESULT] + "\n[Composio result truncated]"
    if completed.returncode:
        error = completed.stderr.strip() or output or f"Exit {completed.returncode}"
        raise RuntimeError(error[:4000])
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        return output


def required_string(request, key, maximum=500):
    value = request.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{key} must be a nonempty string up to {maximum} characters")
    return value.strip()


def not_option(key, value):
    # A value the CLI could read as an option is refused, not passed on.
    if value.startswith("-"):
        raise ValueError(f"{key} must not start with a dash")
    return value


def slug(request):
    value = required_string(request, "slug", 151)
    if not SLUG.fullmatch(value):
        raise ValueError("slug must contain uppercase letters, digits, and underscores")
    return value


def run(request):
    operation = request.get("operation")
    if operation == "connections":
        raw = cli(["connections", "list"])
        if not isinstance(raw, dict):
            raise RuntimeError("Unexpected Composio connections response")
        return {
            toolkit: [
                {
                    key: account.get(key)
                    for key in ("alias", "word_id", "status", "permission_group")
                    if account.get(key) is not None
                }
                for account in accounts
                if isinstance(account, dict)
            ]
            for toolkit, accounts in raw.items()
            if isinstance(accounts, list)
        }
    if operation == "search":
        query = not_option("query", required_string(request, "query"))
        limit = request.get("limit", 8)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20:
            raise ValueError("limit must be an integer from 1 to 20")
        args = ["search", query, "--limit", str(limit)]
        toolkit = request.get("toolkit")
        if toolkit is not None:
            if not isinstance(toolkit, str) or not TOOLKIT.fullmatch(toolkit):
                raise ValueError("toolkit must be one lowercase toolkit slug")
            args += ["--toolkits", toolkit]
        return cli(args)
    if operation == "schema":
        return cli(["execute", slug(request), "--get-schema"])
    if operation == "execute":
        arguments = request.get("arguments", {})
        if not isinstance(arguments, dict):
            raise ValueError("arguments must be a JSON object")
        encoded = json.dumps(arguments, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > 60_000:
            raise ValueError("arguments exceed the 60 KB command limit")
        args = ["execute", slug(request), "-d", "-"]
        if request.get("account") is not None:
            args += ["--account", not_option("account", required_string(request, "account", 150))]
        return cli(args, encoded)
    raise ValueError("Unknown Composio bridge operation")


def main():
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise ValueError("Expected a JSON object")
        result = {"ok": True, "data": run(request)}
    except Exception as error:
        result = {"ok": False, "error": str(error)[:4000]}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
