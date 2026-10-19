const https = require('https');

const BASE_URL = "https://leon4gr45-automaker.hf.space";
const API_KEY = process.env.HF_TOKEN || "mock_token";

const endpoints = [
    { method: "GET", path: "/health", payload: null },
    { method: "GET", path: "/api-docs", payload: null },
    { method: "GET", path: "/api/auth/status", payload: null },
    { method: "POST", path: "/api/auth/login", payload: { apiKey: API_KEY } },
    { method: "GET", path: "/api/argus/modes", payload: null },
    { method: "GET", path: "/api/argus/mode?projectId=registered-project-id", payload: null },
    { method: "PUT", path: "/api/argus/mode", payload: { expectedRevision: 1, mode: "/default" } },
    { method: "POST", path: "/api/argus/mode/plan", payload: { expectedRevision: 1, mode: "/default" } },
    { method: "POST", path: "/api/argus/mode/run", payload: { expectedRevision: 1, approvalSha: "fake-sha" } },
    { method: "GET", path: "/api/argus/mode/runs/1", payload: null },
    { method: "GET", path: "/api/argus/mode/gate", payload: null },
    { method: "GET", path: "/api/projects", payload: null },
    { method: "GET", path: "/api/settings", payload: null },
    { method: "POST", path: "/api/argus/wake", payload: { projectPath: "/app/data/projects/my-project" } },
];

async function request(method, path, payload) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'leon4gr45-automaker.hf.space',
            path: path,
            method: method,
            headers: {
                'X-API-Key': API_KEY,
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({ status: res.statusCode, body: data });
            });
        });

        req.on('error', (e) => reject(e));

        if (payload) {
            req.write(JSON.stringify(payload));
        }
        req.end();
    });
}

async function runTests() {
    console.log("Testing Endpoints with Authentication...\n");
    let results = [];

    for (const ep of endpoints) {
        try {
            console.log(`Testing ${ep.method} ${ep.path} ...`);
            const result = await request(ep.method, ep.path, ep.payload);
            results.push({
                ...ep,
                status: result.status,
                response: result.body
            });
        } catch (e) {
            console.error(`Error on ${ep.method} ${ep.path}: ${e.message}`);
        }
    }

    const fs = require('fs');
    fs.writeFileSync('results.json', JSON.stringify(results, null, 2));
    console.log("\nDone.");
}

runTests();
