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

def await_value(value):
    return asyncio.run(value) if inspect.isawaitable(value) else value

def invoke_manager(name, **kwargs):
    load_service()
    target = getattr(manager_bridge, name, None)
    if not callable(target):
        raise BridgeFailure("ARGUS_UPSTREAM_CONTRACT_MISMATCH", f"manager_bridge.{name} is unavailable")
    return await_value(target(**kwargs))

def plain(value):
    if hasattr(value, "model_dump"): return value.model_dump()
    if hasattr(value, "__dict__"): return dict(value.__dict__)
    return value if isinstance(value, dict) else {"value": value}

def parse_chat_json(response, code):
    response = plain(response)
    if response.get("kind") != "chat" or not isinstance(response.get("reply"), str):
        raise BridgeFailure(code, "Manager did not return a chat reply")
    reply = response["reply"].strip()
    if reply.startswith("```"):
        lines = reply.splitlines()
        if lines and lines[0].strip().lower() in ("```", "```json") and lines[-1].strip() == "```":
            reply = "\n".join(lines[1:-1]).strip()
    try: return json.loads(reply)
    except (TypeError, json.JSONDecodeError): raise BridgeFailure(code, "Manager chat reply was not strict JSON")

def validate_decision(value):
    if not isinstance(value, dict) or not isinstance(value.get("admitted"), bool) or not isinstance(value.get("reason"), str):
        raise BridgeFailure("ARGUS_MANAGER_FAILED", "Manager decision schema is invalid")
    if value.get("recommendedExecutor") not in ("junior", "senior", "review_only", "blocked"):
        raise BridgeFailure("ARGUS_MANAGER_FAILED", "Manager executor is invalid")
    if not isinstance(value.get("evidence"), list) or not all(isinstance(item, str) for item in value["evidence"]) or not isinstance(value.get("needsNextSpec"), bool):
        raise BridgeFailure("ARGUS_MANAGER_FAILED", "Manager decision schema is invalid")
    return value

def validate_evaluation(value):
    if not isinstance(value, dict) or not isinstance(value.get("satisfied"), bool) or not isinstance(value.get("reasoning"), str):
        raise BridgeFailure("OBJECTIVE_EVALUATION_FAILED", "Objective evaluation schema is invalid")
    if not isinstance(value.get("evidence"), list) or not all(isinstance(item, str) for item in value["evidence"]):
        raise BridgeFailure("OBJECTIVE_EVALUATION_FAILED", "Objective evidence is invalid")
    gaps = value.get("remainingGaps")
    if not isinstance(gaps, list) or any(not isinstance(g, dict) or not isinstance(g.get("title"), str) or not isinstance(g.get("description"), str) or not isinstance(g.get("evidence"), list) or not all(isinstance(item, str) for item in g["evidence"]) for g in gaps):
        raise BridgeFailure("OBJECTIVE_EVALUATION_FAILED", "Remaining gaps schema is invalid")
    return value

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
            target = getattr(load_service(), "create_project", None)
            if not callable(target): raise BridgeFailure("ARGUS_UPSTREAM_CONTRACT_MISMATCH", "create_project is unavailable")
            result = plain(await_value(target(workdir=params["projectPath"], name=pid)))
            if result.get("ok") is not True:
                raise BridgeFailure("ARGUS_PROJECT_CREATE_FAILED", str(result.get("error") or result.get("message") or "create_project failed"))
            project = plain(result.get("project"))
            native_sid = str(project.get("sid") or "")
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
        prompt = ("Act only as the Automaker admission brain. Do not enqueue a mission or execute work. "
                  "Using the immutable objective and current campaign below, return ONLY JSON with admitted, reason, evidence, recommendedExecutor, and needsNextSpec.\n\n"
                  f"ARGUS.md:\n{params.get('objective','')[:30000]}\n\nspec.md:\n{params.get('spec','')[:30000]}\n\nLifecycle:\n{json.dumps(params.get('lifecycle',{}))}")
        response = invoke_manager("manager_message", sid=sid, text=prompt, global_root=params.get("projectPath"), route_override="chat", source_channel="automaker")
        return validate_decision(parse_chat_json(response, "ARGUS_MANAGER_FAILED"))
    if operation == "planner_next_task":
        revision = int(params.get("sourceSpecRevision", 1))
        if fake:
            task = {"taskId": f"argus-task-r{revision}", "title": "Implement current specification", "objective": "Advance the current campaign", "description": "Implement the next bounded specification unit", "acceptanceCriteria": ["Relevant tests pass"], "evidenceRequired": ["Test output"], "recommendedExecutor": "junior", "dependencies": [], "risk": "normal", "sourceSpecRevision": revision}
            projects[pid]["tasks"] = [task]; return task
        brief = ("Create ONE bounded next implementation task. Deployment, release, and publishing are prohibited. "
                 "Include concrete acceptance and evidence expectations.\n\n"
                 f"Stable objective:\n{params.get('objective','')[:30000]}\n\nCurrent spec:\n{params.get('spec','')[:30000]}\n\n"
                 f"Manager decision:\n{json.dumps(params.get('managerDecision',{}))}\nSpec revision: {revision}")
        plan = plain(invoke_manager("manager_plan", sid=projects[pid]["nativeSid"], text=brief, global_root=params.get("projectPath")))
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
        prompt = ("Evaluate whether the immutable ARGUS.md objective is fully satisfied. Do not enqueue work and do not redefine the objective. "
                  "Return ONLY strict JSON with satisfied, reasoning, evidence, and remainingGaps.\n\n"
                  f"ARGUS.md:\n{params.get('objective','')[:30000]}\n\nspec.md:\n{params.get('spec','')[:30000]}\n\nCompleted evidence:\n{json.dumps(params.get('evidence',{}))}")
        response = invoke_manager("manager_message", sid=projects[pid]["nativeSid"], text=prompt, global_root=projects[pid].get("projectPath"), route_override="chat", source_channel="automaker")
        return validate_evaluation(parse_chat_json(response, "OBJECTIVE_EVALUATION_FAILED"))
    if operation == "renew_specification":
        if fake:
            return {"spec": "# Renewed campaign\n\n## What was achieved\nPrevious task completed.\n\n## What remains\nNext gap.\n\n## Acceptance criteria\n- Complete the next gap.\n\n## Non-goals\n- Deployment.\n"}
        brief = ("Create the next implementation campaign that closes the remaining objective gaps. Return structured steps and notes; do not execute.\n\n"
                 f"Immutable ARGUS.md:\n{params.get('objective','')[:30000]}\n\nPrevious spec:\n{params.get('spec','')[:30000]}\n\n"
                 f"Objective evaluation:\n{json.dumps(params.get('evaluation',{}))}\n\nNon-goals: deployment, release, publishing.")
        plan = plain(invoke_manager("manager_plan", sid=projects[pid]["nativeSid"], text=brief, global_root=projects[pid].get("projectPath")))
        if plan.get("error"): raise BridgeFailure("SPEC_RENEWAL_FAILED", str(plan["error"]))
        steps = plan.get("steps")
        if not isinstance(steps, list) or not steps: raise BridgeFailure("SPEC_RENEWAL_FAILED", "Planner returned no steps")
        evaluation = params.get("evaluation", {})
        achieved = "\n".join(f"- {item}" for item in evaluation.get("evidence", [])) or "- Previous campaign completed."
        gaps = "\n".join(f"- **{g.get('title','Gap')}**: {g.get('description','')}" for g in evaluation.get("remainingGaps", [])) or "- None recorded."
        planned = []
        for index, step in enumerate(steps, 1):
            row = step if isinstance(step, dict) else {"title": str(step), "detail": str(step)}
            planned.append(f"### {row.get('title') or f'Step {index}'}\n{row.get('detail') or row.get('description') or row.get('objective') or ''}")
        acceptance = [str(item) for step in steps if isinstance(step, dict) for item in (step.get("acceptance_criteria") or step.get("acceptanceCriteria") or [])]
        evidence = [str(item) for step in steps if isinstance(step, dict) for item in (step.get("evidence_required") or step.get("evidenceRequired") or [])]
        spec = (f"# Campaign {params.get('sourceSpecRevision', '')}\n\n## Context\n{evaluation.get('reasoning','Further objective work is required.')}\n\n"
                f"## What was achieved\n{achieved}\n\n## Remaining objective gaps\n{gaps}\n\n## Planned work\n" + "\n\n".join(planned) +
                "\n\n## Acceptance criteria\n" + ("\n".join(f"- {x}" for x in acceptance) or "- Complete and verify the planned work.") +
                "\n\n## Evidence required\n" + ("\n".join(f"- {x}" for x in evidence) or "- Relevant test output.") +
                "\n\n## Non-goals\n- Deployment\n- Release\n- Publishing\n")
        return {"spec": spec}
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
