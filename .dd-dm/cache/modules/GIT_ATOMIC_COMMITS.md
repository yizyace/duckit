# Atomic Commits

## What is an Atomic Commit?

An atomic commit is a commit that represents a single, complete, and self-contained change. It is the smallest possible unit of work that:

1. **Compiles/builds successfully** - The codebase is in a working state after the commit
2. **Passes all tests** - No broken tests are introduced
3. **Is logically complete** - The change makes sense on its own
4. **Is focused** - It does one thing and does it well

## Why Atomic Commits Matter

### 1. Easier Code Reviews

- Reviewers can understand each change in isolation
- Smaller diffs are easier to review thoroughly
- Problems are easier to spot in focused changes

### 2. Safer Reversions

- If a commit introduces a bug, it can be reverted cleanly
- No risk of losing unrelated changes when reverting
- `git bisect` works effectively to find problematic commits

### 3. Better History

- The commit history tells a clear story
- Each commit message explains a specific decision
- Future developers can understand the "why" behind changes

### 4. Simplified Merging

- Atomic commits reduce merge conflicts
- Cherry-picking individual changes is possible
- Branch management becomes cleaner

## Guidelines for Atomic Commits

### DO

- **One logical change per commit**: A bug fix, a feature addition, or a refactor - not all three
- **Include related changes together**: A code change should be committed with its test updates
- **Keep commits small**: If a commit message needs "and" to describe it, it might be too big
- **Commit frequently**: Small, frequent commits are better than large, infrequent ones

### DON'T

- **Mix unrelated changes**: Don't fix a typo in one file while adding a feature in another
- **Leave the build broken**: Every commit should leave the codebase in a working state
- **Commit work-in-progress**: Use branches or stashes for incomplete work
- **Combine formatting changes with logic changes**: These should be separate commits

## Examples

### Good Atomic Commits

```
fix(auth): validate email format before login attempt

Add email format validation to prevent invalid login attempts
that were causing confusing error messages.

Closes #234
```

```
test(auth): add tests for email validation

Cover valid emails, invalid formats, and edge cases like
empty strings and null values.
```

### Bad (Non-Atomic) Commit

```
fix login, add tests, update readme, fix typo in footer

- Fixed the login validation bug
- Added some tests
- Updated the readme with new instructions
- Also fixed a typo I noticed in the footer component
```

This should be 4 separate commits!

## Workflow Tips

1. **Review before committing**: Use `git diff --staged` to review what you're about to commit
2. **Use interactive staging**: `git add -p` lets you stage specific hunks
3. **Commit often**: It's easier to squash commits later than to split them
4. **Write good messages**: Each atomic commit deserves a clear, descriptive message

## Integration with Conventional Commits

Atomic commits work perfectly with the Conventional Commits specification:

- Each atomic commit gets a clear type (feat, fix, refactor, etc.)
- The scope helps identify which part of the codebase changed
- Breaking changes are isolated and clearly marked

## References

- "A Note About Git Commit Messages" - Tim Pope
- "The Art of the Commit" - David Demaree
- Git documentation: https://git-scm.com/book/en/v2/Git-Basics-Recording-Changes-to-the-Repository
