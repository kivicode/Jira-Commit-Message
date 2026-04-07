## [0.0.10] (https://github.com/kivicode/Jira-Commit-Message/compare/0.0.9...0.0.10)
- Remove previous prefix when switching branches

## [0.0.9] (https://github.com/kivicode/Jira-Commit-Message/compare/0.0.8...0.0.9)

- Fix prefix duplication issue with character class patterns like `[A-Z]+`
- Replace regex-based message processing with string operations for better reliability
- Add comprehensive test coverage for character class scenarios and edge cases
- Update VS Code test runner to version 1.95.0
- Improve extension robustness and handle various prefix format templates

## [0.0.8] (https://github.com/kivicode/Jira-Commit-Message/compare/0.0.7...0.0.8)

- Declare vscode.git as extension dependency
- Removal of `gitHeadWatchInterval`, instead the `onDidChange` event of the GitExtension is used

## [0.0.7] (https://github.com/kivicode/Jira-Commit-Message/compare/0.0.7...0.0.6)

- Settings are reloaded on change not requiring restart of vscode anymore #2