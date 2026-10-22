const fs = require('fs');
const { execSync } = require('child_process');

try {
  execSync('git apply --check pr18-safety.patch');
  console.log('Patch is fine.');
} catch (e) {
  console.log('Failed to apply check.');
  // It fails because `git diff` output has the current file state, but `git apply --check` is checking against current index OR HEAD!
  // To check if a patch applies cleanly to a SPECIFIC commit, we should checkout that commit in a temporary worktree!
}
