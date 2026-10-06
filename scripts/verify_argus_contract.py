#!/usr/bin/env python3
"""Opt-in Level-2 smoke for the immutable Argus package; never performs remote writes."""
import os, subprocess, sys, tempfile

REVISION = "746f76b7a74a1217507c9ee348eecd3b782f7c92"
VERSION = "0.1.1"

if os.environ.get("AUTOMAKER_ARGUS_INSTALLED_SMOKE") != "1":
    print("SKIPPED_OPT_IN_REQUIRED")
    raise SystemExit(0)

try:
    with tempfile.TemporaryDirectory() as directory:
        subprocess.run([sys.executable, "-m", "venv", directory], check=True)
        python = os.path.join(directory, "bin", "python")
        pip = os.path.join(directory, "bin", "pip")
        url = f"argus-skill @ https://github.com/microsoft/ArgusAgent/archive/{REVISION}.zip"
        install = subprocess.run([pip, "install", "--disable-pip-version-check", url], text=True, capture_output=True)
        if install.returncode:
            diagnostic = f"{install.stdout}\n{install.stderr}"
            if "403" in diagnostic or "ProxyError" in diagnostic or "Cannot connect to proxy" in diagnostic:
                print("SKIPPED_ENVIRONMENT_NETWORK")
                raise SystemExit(0)
            raise RuntimeError("ARGUS_INSTALL_FAILED")
        code = r'''import importlib.metadata as metadata
import inspect
from argus_skill.plugin.service import ArgusPluginService
from argus_skill.webapi.manager_bridge import manager_message, manager_plan

def require(callable_value, names):
    parameters = inspect.signature(callable_value).parameters
    missing = [name for name in names if name not in parameters]
    if missing:
        raise RuntimeError(f"ARGUS_UPSTREAM_CONTRACT_MISMATCH: {callable_value.__name__} missing {missing}")

if metadata.version("argus-skill") != "0.1.1":
    raise RuntimeError("ARGUS_UPSTREAM_CONTRACT_MISMATCH: package version")
require(ArgusPluginService.create_project, ("workdir", "name"))
require(manager_message, ("sid", "text", "route_override"))
require(manager_plan, ("sid", "text"))
print("ARGUS_CONTRACT_OK")
'''
        subprocess.run([python, "-c", code], check=True, env={**os.environ, "ARGUS_SKILL_RUNNER_BACKEND": "opencode", "ARGUS_SKILL_OPENCODE_PROVIDER": "automaker-compatible"})
except subprocess.CalledProcessError as error:
    raise RuntimeError("ARGUS_UPSTREAM_CONTRACT_MISMATCH") from error
