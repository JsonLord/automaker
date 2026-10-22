git add apps/server/src/services/argus/project-lifecycle.ts apps/server/tests/unit/routes/projects/import-github.test.ts apps/server/src/routes/projects/routes/import-github.ts apps/server/src/services/argus/durable-store.ts
git commit --amend --no-edit
git format-patch HEAD~1 --stdout > /app/pr18-safety.patch
