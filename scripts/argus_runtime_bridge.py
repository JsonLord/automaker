"""Private JSONL adapter for the upstream Argus 0.1.1 loopback WebAPI.

Automaker owns one upstream process. Manager is invoked through Argus's project message route;
Planner output is read from Argus's durable snapshot/backlog rather than recreated here.
"""
import json, os, shutil, subprocess, sys, time, urllib.error, urllib.request

projects, events = {}, {}
native = None
port = int(os.environ.get("ARGUS_WEB_PORT", "8799"))
base = f"http://127.0.0.1:{port}"
fake = os.environ.get("ARGUS_BRIDGE_FAKE") == "1"

class BridgeFailure(Exception):
    def __init__(self, code, message, retryable=False):
        super().__init__(message); self.code, self.retryable = code, retryable

def http(method, route, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + route, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read().decode(); return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raise BridgeFailure("ARGUS_UPSTREAM_HTTP", f"Argus WebAPI returned HTTP {exc.code}", exc.code >= 500)
    except (urllib.error.URLError, TimeoutError) as exc:
        raise BridgeFailure("ARGUS_UPSTREAM_UNAVAILABLE", type(exc).__name__, True)

def start_native():
    global native
    if fake or native is not None: return
    binary = os.environ.get("ARGUS_BIN") or shutil.which("argus")
    if not binary: raise BridgeFailure("ARGUS_NOT_INSTALLED", "argus executable not installed")
    native = subprocess.Popen([binary, "--web", "--no-open", "--web-host", "127.0.0.1",
                               "--web-port", str(port)], stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                              env={k: v for k, v in os.environ.items() if k in
                                   ("PATH", "HOME", "COMPATIBLE_API_KEY")})
    for _ in range(50):
        if native.poll() is not None: raise BridgeFailure("ARGUS_START_FAILED", "Argus WebAPI exited")
        try: http("GET", "/api/projects", timeout=1); return
        except BridgeFailure: time.sleep(.1)
    raise BridgeFailure("ARGUS_START_TIMEOUT", "Argus WebAPI did not become ready", True)

def task_from_row(row, revision):
    task_id = str(row.get("id") or row.get("task_id") or "")
    return {"taskId": task_id, "title": row.get("title") or row.get("objective") or task_id,
            "objective": row.get("objective") or row.get("title") or "",
            "description": row.get("description") or row.get("reason") or "",
            "acceptanceCriteria": row.get("acceptance_criteria") or ([row["acceptance_check"]] if row.get("acceptance_check") else []),
            "evidenceRequired": row.get("evidence_required") or row.get("context_refs") or [],
            "recommendedExecutor": "junior", "dependencies": row.get("deps") or [],
            "risk": row.get("risk") or "normal", "sourceSpecRevision": revision}

def operate(operation, params):
    if operation == "health":
        binary = os.environ.get("ARGUS_BIN") or shutil.which("argus")
        return {"running": True, "upstreamInstalled": bool(binary) or fake,
                "version": "fake-0.1.1" if fake else "0.1.1"}
    if operation == "shutdown":
        if native is not None: native.terminate()
        return {"stopped": True}
    pid = params.get("projectId", "")
    if operation == "ensure_project":
        if not fake:
            start_native()
            try: http("GET", f"/api/projects/{pid}/status")
            except BridgeFailure: http("POST", "/api/projects", {"sid": pid, "name": pid, "workdir": params["projectPath"], "backend": "opencode"})
        created = pid not in projects; projects.setdefault(pid, dict(params)); events.setdefault(pid, [])
        return {"projectId": pid, "created": created}
    if operation == "resume_project":
        if not fake: http("GET", f"/api/projects/{pid}/status")
        return {"projectId": pid, "status": "resumed"}
    if operation == "get_status": return http("GET", f"/api/projects/{pid}/status") if not fake else {"status": "ready"}
    if operation == "manager_handoff":
        if fake:
            result = {"admitted": True, "reason": "campaign advances the objective", "evidence": ["ARGUS.md", "spec.md"], "recommendedExecutor": "junior", "needsNextSpec": False}
            projects[pid]["decision"] = result; return result
        message = ("Evaluate the bounded Automaker campaign using ARGUS.md and spec.md at the supplied workdir. "
                   "Admit and route the next useful work through your native Planner. Deployment is forbidden; ARGUS.md is immutable.")
        response = http("POST", f"/api/projects/{pid}/message", {"message": message}, timeout=170)
        return {"admitted": not bool(response.get("blocked")), "reason": response.get("message") or response.get("status") or "Manager admitted campaign", "evidence": ["ARGUS.md", "spec.md"], "recommendedExecutor": "junior", "needsNextSpec": False}
    if operation == "planner_next_task":
        revision = int(params.get("sourceSpecRevision", 1))
        if fake:
            task = {"taskId": f"argus-task-r{revision}", "title": "Implement current specification", "objective": "Advance the current campaign", "description": "Implement the next bounded specification unit", "acceptanceCriteria": ["Relevant tests pass"], "evidenceRequired": ["Test output"], "recommendedExecutor": "junior", "dependencies": [], "risk": "normal", "sourceSpecRevision": revision}
            projects[pid]["tasks"] = [task]; return task
        snapshot = http("GET", f"/api/projects/{pid}/snapshot?compact=false")
        rows = snapshot.get("backlog") or snapshot.get("pending_work") or []
        pending = [row for row in rows if str(row.get("status", "pending")).lower() not in ("done", "completed", "retired")]
        return task_from_row(pending[0], revision) if pending else None
    if operation == "get_pending_work": return projects.get(pid, {}).get("tasks", []) if fake else [task_from_row(row, 1) for row in http("GET", f"/api/projects/{pid}/snapshot?compact=true").get("backlog", [])]
    if operation == "get_recent_events": return events.get(pid, [])[-20:] if fake else http("GET", f"/api/projects/{pid}/snapshot?compact=true").get("events", [])[-20:]
    raise BridgeFailure("ARGUS_UNKNOWN_OPERATION", operation)

for raw in sys.stdin:
    request = {"requestId": 0}
    try:
        request = json.loads(raw); result = operate(request.get("operation", ""), request.get("params", {}))
        response = {"requestId": request["requestId"], "ok": True, "result": result}
    except BridgeFailure as exc:
        response = {"requestId": request["requestId"], "ok": False, "error": {"code": exc.code, "message": str(exc), "retryable": exc.retryable}}
    except Exception as exc:
        response = {"requestId": request["requestId"], "ok": False, "error": {"code": "ARGUS_MALFORMED_RESPONSE", "message": type(exc).__name__, "retryable": False}}
    print(json.dumps(response), flush=True)
    if request.get("operation") == "shutdown": break
