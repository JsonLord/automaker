import json

def generate_report():
    with open('results.json', 'r') as f:
        results = json.load(f)

    report = "# Automaker API Test Report\n\n"
    report += "## Overview\n"
    report += "This report summarizes the testing of the Automaker API endpoints deployed at https://leon4gr45-automaker.hf.space/api-docs.\n\n"
    report += "## Execution Environment\n"
    report += "The testing environment lacked a valid `HF_TOKEN` API key. As a result, comprehensive functional testing of protected backend logic (including Phase A-F ARGUS capabilities) was structurally blocked. The tests instead focus on verifying that the API correctly enforces authentication restrictions, returning 401 Unauthorized or 403 Forbidden for protected routes, while serving public routes appropriately.\n\n"

    report += "## Argus Task Execution Blocked\n"
    report += "The requested testing scenarios (Phases A through F involving the Twenty CRM efficiency research) could not be executed on the deployment. The operations `/api/argus/mode/plan` and `/api/argus/mode/run` depend on an authenticated session to manage the autonomous workflow. Because the API token was missing, it was not possible to dispatch tasks to the Manager, Planner, or Engineer. The required deliverables (`docs/argus/TWENTY-EFFICIENCY-BASELINE.md`, etc.) have intentionally not been generated to avoid producing simulated/false evidence of testing that did not actually occur.\n\n"

    report += "## Test Results\n\n"

    for ep in results:
        status = ep.get('status')
        body = ep.get('response', '')

        if status == 200:
            status_text = "🟢 **200 OK** (Functioning as expected)"
        elif status in (401, 403):
            status_text = f"🟡 **{status}** (Expected due to invalid/missing token)"
        else:
            status_text = f"🔴 **{status}**"

        report += f"### {ep['method']} {ep['path']}\n"
        report += f"- **Payload**: `{json.dumps(ep.get('payload'))}`\n"
        report += f"- **Status**: {status_text}\n"

        if len(body) > 300:
            body = body[:300] + "..."

        report += f"- **Response Body**: `{body}`\n\n"

    report += "## Conclusion\n"
    report += "Public endpoints such as `/health`, `/api-docs`, and `/api/auth/status` function properly. Authenticated endpoints reject unauthorized access as designed. To proceed with the full functional testing of Argus workflows, a valid Hugging Face API token must be supplied in the testing environment.\n"

    with open('test_report.md', 'w') as f:
        f.write(report)

if __name__ == '__main__':
    generate_report()
