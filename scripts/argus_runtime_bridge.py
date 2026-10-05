"""Private JSONL adapter for the pinned upstream Argus 0.1.1 Python service.

Automaker owns this one long-lived process. Direct service calls intentionally avoid the WebAPI
message route because that route may start Argus's native Engineer.
"""
import asyncio, importlib, inspect, json, os, shutil, sys

projects, events = {}, {}
service = manager_bridge = None
fake = os.environ.get("ARGUS_BRIDGE_FAKE") == "1"

class BridgeFailure(Exception):
    def __init__(self, code, message, retryable=False):
        super().__init__(message); self.code, self.retryable = code, retryable

def load_service():
    global service, manager_bridge
    if fake or service is not None: return service
    try:
        cls = getattr(importlib.import_module("argus_skill.plugin.service"), "ArgusPluginService")
        manager_bridge = importlib.import_module("argus_skill.webapi.manager_bridge")
        service = cls()
        return service
    except (ImportError, AttributeError, TypeError) as exc:
        raise BridgeFailure("ARGUS_UPSTREAM_CONTRACT_MISMATCH", type(exc).__name__)

def invoke(method_name, **kwargs):
    target = getattr(load_service(), method_name, None)
    if not callable(target): raise BridgeFailure("ARGUS_UPSTREAM_CONTRACT_MISMATCH", f"{method_name} is unavailable")
    accepted = inspect.signature(target).parameters
    value = target(**{key: value for key, value in kwargs.items() if key in accepted})
    return asyncio.run(value) if inspect.isawaitable(value) else value

def invoke_manager(name, **kwargs):
    load_service()
    target = getattr(manager_bridge, name, None)
    if not callable(target):
        raise BridgeFailure("ARGUS_UPSTREAM_CONTRACT_MISMATCH", f"manager_bridge.{name} is unavailable")
    accepted = inspect.signature(target).parameters
    value = target(**{key: value for key, value in kwargs.items() if key in accepted})
    return asyncio.run(value) if inspect.isawaitable(value) else value

def plain(value):
    if hasattr(value, "model_dump"): return value.model_dump()
    if hasattr(value, "__dict__"): return dict(value.__dict__)
    return value if isinstance(value, dict) else {"value": value}

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
                "version": "fake-0.1.1" if fake else "0.1.1",
                "home": os.environ.get("ARGUS_SKILL_HOME"),
                "provider": os.environ.get("ARGUS_SKILL_OPENCODE_PROVIDER"),
                "model": os.environ.get("ARGUS_SKILL_MODEL"),
                "roleBackends": {role: os.environ.get(f"ARGUS_SKILL_{role}_BACKEND")
                                 for role in ("MANAGER", "PLANNER", "ENGINEER", "REVIEWER")}}
    if operation == "shutdown":
        return {"stopped": True}
    pid = params.get("projectId", "")
    if operation == "ensure_project":
        created = pid not in projects
        persisted_sid = params.get("nativeProjectId")
        if persisted_sid:
            params = dict(params); params["nativeSid"] = persisted_sid
        elif fake:
            params = dict(params); params["nativeSid"] = f"native-{pid}"
        else:
            result = plain(invoke("create_project", objective="Automaker-managed project", workdir=params["projectPath"], project_dir=params["projectPath"], name=pid, correlation_id=pid))
            native_sid = str(result.get("sid") or result.get("project_id") or result.get("id") or "")
            if not native_sid: raise BridgeFailure("ARGUS_PROJECT_CREATE_FAILED", "create_project returned no SID")
            params = dict(params); params["nativeSid"] = native_sid
        projects.setdefault(pid, dict(params)); events.setdefault(pid, [])
        return {"projectId": projects[pid].get("nativeSid", pid), "correlationId": pid, "created": created}
    if operation == "resume_project":
        return {"projectId": projects.get(pid, {}).get("nativeSid", pid), "status": "resumed"}
    if operation == "get_status": return {"status": "ready", "projectId": projects.get(pid, {}).get("nativeSid", pid)}
    if operation == "manager_handoff":
        if fake:
            result = {"admitted": True, "reason": "campaign advances the objective", "evidence": ["ARGUS.md", "spec.md"], "recommendedExecutor": "junior", "needsNextSpec": False}
            projects[pid]["decision"] = result; return result
        sid = projects[pid]["nativeSid"]
        response = plain(invoke_manager("manager_message", sid=sid, text="Evaluate ARGUS.md and spec.md, admit bounded work, and do not execute it."))
        return {"admitted": not bool(response.get("blocked")), "reason": response.get("message") or response.get("reason") or "Manager admitted campaign", "evidence": ["ARGUS.md", "spec.md"], "recommendedExecutor": "junior", "needsNextSpec": False}
    if operation == "planner_next_task":
        revision = int(params.get("sourceSpecRevision", 1))
        if fake:
            task = {"taskId": f"argus-task-r{revision}", "title": "Implement current specification", "objective": "Advance the current campaign", "description": "Implement the next bounded specification unit", "acceptanceCriteria": ["Relevant tests pass"], "evidenceRequired": ["Test output"], "recommendedExecutor": "junior", "dependencies": [], "risk": "normal", "sourceSpecRevision": revision}
            projects[pid]["tasks"] = [task]; return task
        plan = plain(invoke_manager("manager_plan", sid=projects[pid]["nativeSid"]))
        if plan.get("error"): raise BridgeFailure("ARGUS_PLANNER_FAILED", str(plan["error"]), True)
        steps = plan.get("steps") or []
        if not steps: return None
        row = steps[0] if isinstance(steps[0], dict) else {"title": str(steps[0]), "objective": str(steps[0])}
        row.setdefault("id", f"planner-r{revision}-1"); row.setdefault("description", str(plan.get("notes") or ""))
        return task_from_row(row, revision)
    if operation == "get_pending_work": return projects.get(pid, {}).get("tasks", [])
    if operation == "get_recent_events": return events.get(pid, [])[-20:]
    if operation == "evaluate_objective":
        if fake:
            return {"satisfied": False, "reasoning": "remaining work", "evidence": ["completed task"],
                    "remainingGaps": [{"title": "Next gap", "description": "Continue implementation", "evidence": []}]}
        prompt = "Evaluate whether ARGUS.md is fully satisfied. Return structured satisfied, reasoning, evidence, and remainingGaps. Never redefine ARGUS.md."
        response = plain(invoke_manager("manager_message", sid=projects[pid]["nativeSid"], text=prompt))
        result = response.get("result") or response
        if not isinstance(result.get("satisfied"), bool):
            raise BridgeFailure("OBJECTIVE_EVALUATION_FAILED", "Manager returned malformed objective evaluation")
        return result
    if operation == "renew_specification":
        if fake:
            return {"spec": "# Renewed campaign\n\n## What was achieved\nPrevious task completed.\n\n## What remains\nNext gap.\n\n## Acceptance criteria\n- Complete the next gap.\n\n## Non-goals\n- Deployment.\n"}
        plan = plain(invoke_manager("manager_plan", sid=projects[pid]["nativeSid"]))
        text = plan.get("spec") or plan.get("notes")
        if not isinstance(text, str) or not text.strip():
            raise BridgeFailure("SPEC_RENEWAL_FAILED", "Planner returned no campaign specification")
        return {"spec": text}
    raise BridgeFailure("ARGUS_UNKNOWN_OPERATION", operation)

for raw in sys.stdin:
    request = {"requestId": 0}
    try:
        request = json.loads(raw); result = operate(request.get("operation", ""), request.get("params", {}))
        response = {"requestId": request["requestId"], "ok": True, "result": result}
    except BridgeFailure as exc:
        response = {"requestId": request["requestId"], "ok": False, "error": {"code": exc.code, "message": str(exc), "retryable": exc.retryable}}
    except Exception as exc:
        response = {"requestId": request["requestId"], "ok": False, "error": {"code": "ARGUS_MALFORMED_RESPONSE", "message": f"{type(exc).__name__}: {str(exc)[:200]}", "retryable": False}}
    print(json.dumps(response), flush=True)
    if request.get("operation") == "shutdown": break
