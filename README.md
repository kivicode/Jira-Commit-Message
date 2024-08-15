# Jira Commit Message Extension for VSCode

This VSCode extension automatically prefixes commit messages with a Jira issue code extracted from the branch name.
Developed in hopes to make the process of dealing with Jira a tiny bit less annoying.

## Features

- **Automatic Prefixing:** Automatically adds a Jira issue code as a prefix to commit messages based on the current branch name.
- **Customizable Patterns:** Allows for custom configuration of the issue code extraction pattern and commit message format.
- **Outdated Prefix Handling:** Detects and updates outdated prefixes in commit messages when the branch changes.

## Configuration

Customize the extension behavior via the following settings in your VSCode `settings.json`:

- `commitMessagePrefixPattern`: Regex pattern to match issue prefixes in branch names. Default is `(ML-\d+)-.*`.
- `commitMessageFormat`: Format for the commit message. Use `${prefix}` for the branch prefix and `${message}` for the original commit message. Default is `"[${prefix}] ${message}"`.
- `gitHeadWatchInterval`: Interval in milliseconds to watch the `.git/HEAD` file for changes. Default is `1000`.

## Usage

Once installed, the extension automatically watches for branch changes and updates the commit message input in VSCode's Source Control panel according to the configured patterns.

## Installation

Install the extension directly from the Visual Studio Code Marketplace:
1. Open VSCode.
2. Navigate to Extensions by clicking on the square icon on the sidebar or pressing Ctrl+Shift+X.
3. Search for "Jira Commit Message".
4. Click on "Install".

Alternatively, you can install it via the [VSCode Marketplace website](https://marketplace.visualstudio.com/items?itemName=KiviCode.jira-commit-message).

## Contributing

Contributions are welcome! Please submit pull requests with any enhancements, bug fixes, or suggestions.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
