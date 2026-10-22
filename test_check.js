const fs = require('fs');

let testCode = fs.readFileSync(
  'apps/server/tests/unit/routes/projects/import-github.test.ts',
  'utf8'
);
console.log(testCode.substring(0, 500));
