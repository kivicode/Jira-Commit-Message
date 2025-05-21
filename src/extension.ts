import * as vscode from "vscode";
import { GitExtension, Repository } from "./git";

const LOG_PREFIX = "[Jira Commit Message]";

interface ExtensionConfig {
  commitMessagePrefixPattern: RegExp;
  commitMessageFormat: string;
  outdatedPrefixPattern: RegExp;
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
    this.watcher = this.repo.state.onDidChange(() => this.safeUpdateCommitMessage());
  }

  private safeUpdateCommitMessage(currentMessage?: string) {
    try {
      updateCommitMessage(this.repo, this.config, (msg) => this.log(msg), currentMessage);
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
    this.safeUpdateCommitMessage(currentMessage);
  }

  public dispose() {
    // Cleanup gitHeadWatcher and file watchers
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

  const match = tagPattern.match(/\(([^)]+)\)/);
  const prefixPattern = match ? match[1] : tagPattern;
  const outdatedPrefixPattern: string = msgFormat
    .replace("${prefix}", `(${prefixPattern})`)
    .replace("${message}", "(.*)")
    .replace(/[\[\]]/g, "\\$&")
    .replace(/\$/g, "\\$");

  return {
    commitMessagePrefixPattern: new RegExp(tagPattern),
    commitMessageFormat: msgFormat,
    outdatedPrefixPattern: new RegExp(outdatedPrefixPattern)
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

  const updatedMessage = getCommitMessage(branch, currentMessage, config);

  if (repo.inputBox.value !== updatedMessage) {
    log(`Updating commit message "${repo.inputBox.value}" on branch ${branch} to "${updatedMessage}"`);
    repo.inputBox.value = updatedMessage;
  } else {
    log(`Commit message on branch ${branch} is already "${updatedMessage}".`);
  }
}

function extractCurrentMessage(
  repo: Repository,
  config: ExtensionConfig
): string {
  return repo.inputBox.value.replace(config.outdatedPrefixPattern, "$2");
}

function getCommitMessage(
  branch: string,
  currentMessage: string,
  config: ExtensionConfig
): string {
  if (!config.commitMessagePrefixPattern.test(branch)) {
    return currentMessage;
  }

  const prefixMatch = branch.match(config.commitMessagePrefixPattern);
  if (!prefixMatch) {
    return currentMessage;
  }

  const prefix = prefixMatch[1];

  const prefixRegex = new RegExp(`^\\[${prefix}\\]\\s`);
  if (prefixRegex.test(currentMessage)) {
    return currentMessage;
  }

  const withoutExistingPrefix = currentMessage
    .replace(config.outdatedPrefixPattern, "")
    .trim();
  const formattedMessage = config.commitMessageFormat
    .replace("${prefix}", prefix)
    .replace("${message}", withoutExistingPrefix);

  return formattedMessage;
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
    `${LOG_PREFIX} Loaded configuration ${JSON.stringify(config)}`
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
      outputChannel.appendLine(`${LOG_PREFIX} Already watching ${repo.rootUri}`);
      return;
    } 
    const watcher = new RepositoryWatcher(repo, config, outputChannel);
    repoWatchers.push(watcher);
  };

  const removeRepoWatcher = (repo: Repository): void => {
    const index = repoWatchers.findIndex((watcher) => watcher.repo.rootUri.toString() === repo.rootUri.toString());
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

  (git.state === "initialized"? Promise.resolve() : new Promise<void>((resolve) => {
    git.onDidChangeState((state) => {
      if (state === 'initialized') {
        resolve();
      }
    });
  })).then(
    () => {
      git.repositories.forEach(addRepoWatcher);
      context.subscriptions.push(git.onDidOpenRepository(addRepoWatcher));
      context.subscriptions.push(git.onDidCloseRepository(removeRepoWatcher));
    }
  );

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
            updateCommitMessage(repo, config, (msg) => outputChannel.appendLine(
              `${LOG_PREFIX}  ${msg}`));
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
