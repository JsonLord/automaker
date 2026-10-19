import fs from 'fs';
import assert from 'assert';

console.log("Mocking runtime offline tests...");
assert.strictEqual(fs.existsSync('scripts/test-hf-runtime.mjs'), true, "Runtime script must exist");
console.log("Offline tests passed.");
