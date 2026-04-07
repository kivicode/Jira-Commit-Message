import * as vscode from "vscode";
import { GitExtension, Repository } from "./git";

const LOG_PREFIX = "[Jira Commit Message]";

interface ExtensionConfig {
  commitMessagePrefixPattern: RegExp;
  commitMessageFormat: string;
  messageExtractionRegex: RegExp;
}

class RepositoryWatcher {
  public repo: Repository;
  private config: ExtensionConfig;
  private watcher?: vscode.Disposable;

  constructor(
    repo: Repository,
    config: ExtensionConfig,
    private outputChannel: vscode.OutputChannel
  ) {
    this.repo = repo;
    this.config = config;

    this.log(`Watching ${this.repo.rootUri}`);
    this.setupWatchers();
    this.safeUpdateCommitMessage(); // Initial update
  }

  private setupWatchers() {
    this.watcher = this.repo.state.onDidChange(() =>
      this.safeUpdateCommitMessage()
    );
  }

  private safeUpdateCommitMessage(currentMessage?: string) {
    try {
      updateCommitMessage(
        this.repo,
        this.config,
        (msg) => this.log(msg),
        currentMessage
      );
    } catch (error) {
      this.log(`Error updating commit message: ${(error as Error).message}`);
    }
  }

  private log(message: string) {
    this.outputChannel.appendLine(
      `${LOG_PREFIX} [RepositoryWatcher] ${message}`
    );
  }

  public updateConfig(newConfig: ExtensionConfig) {
    const oldConfig = this.config;
    this.config = newConfig;

    const currentMessage = extractCurrentMessage(this.repo, oldConfig);
    // If the prefixPattern is changed, we need to extract the message with the old config.
    this.safeUpdateCommitMessage(currentMessage);
  }

  public dispose() {
    this.watcher?.dispose();
    this.log(`Stopped watching repository: ${this.repo.rootUri}`);
  }
}

function getExtensionConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration("jira-commit-message");
  const tagPattern = config.get<string>(
    "commitMessagePrefixPattern",
    "(ML-\\d+)-.*"
  );
  const msgFormat = config.get<string>(
    "commitMessageFormat",
    "[${prefix}] ${message}"
  );
  const commitMessagePrefixPattern = new RegExp(tagPattern);

  const messageExtractionRegex = createMessageExtractionRegex(
    msgFormat,
    commitMessagePrefixPattern
  );
  return {
    commitMessagePrefixPattern,
    commitMessageFormat: msgFormat,
    messageExtractionRegex: messageExtractionRegex,
  };
}

function updateCommitMessage(
  repo: Repository,
  config: ExtensionConfig,
  log: (message: string) => void,
  currentMessage?: string
): void {
  const branch: string = repo.state.HEAD?.name ?? "";
  if (!branch) {
    log(`repo.state.HEAD is empty. Skipping`);
    return;
  }

  if (typeof currentMessage === "undefined") {
    currentMessage = extractCurrentMessage(repo, config);
  }
  const updatedMessage = buildCommitMessage(currentMessage, branch, config);

  if (repo.inputBox.value !== updatedMessage) {
    log(
      `Updating commit message "${repo.inputBox.value}" on branch ${branch} to "${updatedMessage}"`
    );
    repo.inputBox.value = updatedMessage;
  } else {
    log(`Commit message on branch ${branch} is already "${updatedMessage}".`);
  }
}

function extractCurrentMessage(
  repo: Repository,
  config: ExtensionConfig
): string {
  const currentValue = repo.inputBox.value;
  const extractedMessage = extractMessageFromFormattedMessage(currentValue, config);
  return extractedMessage.trim();
}

function buildCommitMessage(
  currentMessage: string,
  branch: string,
  config: ExtensionConfig
): string {
  

  // Doesn't match branch pattern? Leave as is.
  if (!config.commitMessagePrefixPattern.test(branch)) {
    return currentMessage;
  }

  const prefixMatch = branch.match(config.commitMessagePrefixPattern);
  if (!prefixMatch) {
    // This shouldn't happen. We just checked it.
    return currentMessage;
  }

  const prefix = prefixMatch[1];

  // Build message according to message format
  const formattedMessage = config.commitMessageFormat
    .replace("${prefix}", prefix)
    .replace("${message}", currentMessage);

  return formattedMessage;
}

function extractMessageFromFormattedMessage(
  message: string,
  config: ExtensionConfig
): string {
  const match = message.match(config.messageExtractionRegex);
  return match?.groups?.message ?? message;
}

function createMessageExtractionRegex(
  format: string,
  commitMessagePrefixPattern: RegExp
): RegExp {
  const prefixToken = "${prefix}";
  const messageToken = "${message}";
  const fallbackMessageRegex = /^(?<message>.*)$/;

  if (!format.includes(prefixToken) || !format.includes(messageToken)) {
    console.error(
      `${LOG_PREFIX} commitMessageFormat must contain both ${prefixToken} and ${messageToken}. Falling back to message passthrough regex.`
    );
    return fallbackMessageRegex;
  }

  const branchPrefixPattern = getBranchPrefixPattern(commitMessagePrefixPattern);
  if (!branchPrefixPattern) {
    console.error(
      `${LOG_PREFIX} commitMessagePrefixPattern must contain a capture group for the prefix. Falling back to message passthrough regex.`
    );
    return fallbackMessageRegex;
  }

  const escapedFormat = escapeRegExp(format);
  const patternWithPrefix = escapedFormat.replace(
    escapeRegExp(prefixToken),
    `(?:${branchPrefixPattern})`
  );
  const fullPattern = patternWithPrefix.replace(
    escapeRegExp(messageToken),
    "(?<message>.*)"
  );

  return new RegExp(`^${fullPattern}$`);
}

function getBranchPrefixPattern(prefixPattern: RegExp): string | undefined {
  const firstGroupMatch = prefixPattern.source.match(/\(([^)]+)\)/);
  return firstGroupMatch?.[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel(
    LOG_PREFIX.slice(1, LOG_PREFIX.length - 1)
  );
  outputChannel.appendLine(`${LOG_PREFIX} Extension activated`);

  const gitExtension: GitExtension | undefined =
    vscode.extensions.getExtension<GitExtension>("vscode.git")?.exports;
  if (!gitExtension) {
    outputChannel.appendLine(`${LOG_PREFIX} Unable to load the Git extension`);
    return;
  }
  const git = gitExtension.getAPI(1);
  let config = getExtensionConfig();
  outputChannel.appendLine(
    `${LOG_PREFIX} Loaded configuration `+
    `{commitMessageFormat: '${config.commitMessageFormat}', ` +
    // Regex can't be printed with JSON.stringify
    `commitMessagePrefixPattern: ${config.commitMessagePrefixPattern}, ` +
    `messageExtractionRegex: ${config.messageExtractionRegex}}`
  );

  const repoWatchers: RepositoryWatcher[] = [];

  const updateRepositoryWatchers = (newConfig: ExtensionConfig) => {
    for (const watcher of repoWatchers) {
      watcher.updateConfig(newConfig);
    }
  };

  const addRepoWatcher = (repo: Repository) => {
    const existingWatcher = repoWatchers.find(
      (watcher) => watcher.repo === repo
    );
    if (existingWatcher) {
      outputChannel.appendLine(
        `${LOG_PREFIX} Already watching ${repo.rootUri}`
      );
      return;
    }
    const watcher = new RepositoryWatcher(repo, config, outputChannel);
    repoWatchers.push(watcher);
  };

  const removeRepoWatcher = (repo: Repository): void => {
    const index = repoWatchers.findIndex(
      (watcher) => watcher.repo.rootUri.toString() === repo.rootUri.toString()
    );
    if (index !== -1) {
      repoWatchers[index].dispose();
      repoWatchers.splice(index, 1);
    }
  };

  updateRepositoryWatchers(config);

  const configSubscription = vscode.workspace.onDidChangeConfiguration(
    (event) => {
      if (event.affectsConfiguration("jira-commit-message")) {
        config = getExtensionConfig();
        outputChannel.appendLine(
          `${LOG_PREFIX} Configuration changed to ${JSON.stringify(config)}`
        );
        updateRepositoryWatchers(config);
      }
    }
  );

  (git.state === "initialized"
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        git.onDidChangeState((state) => {
          if (state === "initialized") {
            resolve();
          }
        });
      })
  ).then(() => {
    git.repositories.forEach(addRepoWatcher);
    context.subscriptions.push(git.onDidOpenRepository(addRepoWatcher));
    context.subscriptions.push(git.onDidCloseRepository(removeRepoWatcher));
  });

  context.subscriptions.push(
    configSubscription,
    new vscode.Disposable(() => {
      while (repoWatchers.length > 0) {
        const watcher = repoWatchers.pop();
        watcher?.dispose();
      }
    }),
    vscode.commands.registerCommand(
      "jira-commit-message.update-message",
      () => {
        git.repositories.forEach((repo) => {
          try {
            updateCommitMessage(repo, config, (msg) =>
              outputChannel.appendLine(`${LOG_PREFIX}  ${msg}`)
            );
          } catch (error) {
            outputChannel.appendLine(
              `${LOG_PREFIX} Error executing update command: ${
                (error as Error).message
              }`
            );
          }
        });
      }
    )
  );
}

export function deactivate(): void {
  const outputChannel = vscode.window.createOutputChannel(LOG_PREFIX);
  outputChannel.appendLine(`${LOG_PREFIX} Extension deactivated`);
}
