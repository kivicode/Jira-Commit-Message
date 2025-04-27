import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { GitExtension, Repository } from "./git";

const LOG_PREFIX = "[Jira Commit Message]";

interface ExtensionConfig {
  commitMessagePrefixPattern: RegExp;
  commitMessageFormat: string;
  gitHeadWatchInterval: number;
  outdatedPrefixPattern: RegExp;
}

class RepositoryWatcher {
  public repo: Repository;
  private config: ExtensionConfig;
  private gitHeadWatcher?: fs.StatWatcher;
  private refWatcher?: { path: string; timer: NodeJS.Timeout };

  constructor(
    repo: Repository,
    config: ExtensionConfig,
    private outputChannel: vscode.OutputChannel
  ) {
    this.repo = repo;
    this.config = config;

    this.log(`Watching repository: ${this.repo.rootUri.fsPath}`);
    this.setupWatchers();
    this.safeUpdateCommitMessage(); // Initial update
  }

  private setupWatchers() {
    const gitDir = path.join(this.repo.rootUri.fsPath, ".git");
    const gitHeadPath = path.join(gitDir, "HEAD");

    // Initialize and store the gitHeadWatcher
    this.gitHeadWatcher = fs.watchFile(
      gitHeadPath,
      { interval: this.config.gitHeadWatchInterval },
      () => {
        this.log(`Detected change in HEAD file: ${gitHeadPath}`);
        this.handleGitHeadChange(gitHeadPath);
      }
    );

    // Handle initial branch ref watcher
    fs.readFile(gitHeadPath, "utf8", (err, headContent) => {
      if (err) {
        this.log(`Error reading .git/HEAD: ${err.message}`);
        return;
      }
      const refPath = this.getBranchRefPath(gitDir, headContent);
      if (refPath) {
        this.setupRefWatcher(refPath);
      }
    });
  }

  private setupRefWatcher(refPath: string) {
    // Cleanup any existing ref watcher
    if (this.refWatcher) {
      fs.unwatchFile(this.refWatcher.path);
      clearTimeout(this.refWatcher.timer);
      this.log(`Stopped watching old ref file: ${this.refWatcher.path}`);
    }

    // Watch branch ref file using fs.watchFile for interval control
    fs.watchFile(
      refPath,
      { interval: this.config.gitHeadWatchInterval },
      () => {
        this.log(`Detected change in branch ref file: ${refPath}`);
        this.safeUpdateCommitMessage();
      }
    );

    // Track the current ref watcher
    this.log(`Watching branch ref file: ${refPath}`);
    this.refWatcher = { path: refPath, timer: setTimeout(() => {}, 0) }; // Timer is just a placeholder
  }

  private handleGitHeadChange(gitHeadPath: string) {
    fs.readFile(gitHeadPath, "utf8", (err, headContent) => {
      if (err) {
        this.log(`Error reading HEAD file: ${err.message}`);
        return;
      }
      const gitDir = path.dirname(gitHeadPath);
      const refPath = this.getBranchRefPath(gitDir, headContent);
      this.log(`Headcontent is now ${headContent}`);
      if (refPath) {
        this.setupRefWatcher(refPath);
      }
      this.safeUpdateCommitMessage();
    });
  }

  private getBranchRefPath(gitDir: string, headContent: string): string | null {
    if (!headContent.startsWith("ref:")) return null;
    const branchRef = headContent.split(" ")[1].trim();
    return path.join(gitDir, branchRef);
  }

  private safeUpdateCommitMessage(currentMessage?: string) {
    try {
      updateCommitMessage(this.repo, this.config, currentMessage);
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
    
    if (oldConfig.gitHeadWatchInterval !== newConfig.gitHeadWatchInterval) {
      this.log("Watch interval changed, recreating watchers");
      this.dispose();
      this.setupWatchers();
    }
    const currentMessage = extractCurrentMessage(this.repo, oldConfig);
    this.safeUpdateCommitMessage(currentMessage);
  }

  public dispose() {
    // Cleanup gitHeadWatcher and file watchers
    if (this.gitHeadWatcher) {
      fs.unwatchFile(path.join(this.repo.rootUri.fsPath, ".git", "HEAD"));
    }
    if (this.refWatcher) {
      fs.unwatchFile(this.refWatcher.path);
      clearTimeout(this.refWatcher.timer);
      this.log(`Stopped watching branch ref file: ${this.refWatcher.path}`);
    }
    this.log(`Stopped watching repository: ${this.repo.rootUri.fsPath}`);
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
    outdatedPrefixPattern: new RegExp(outdatedPrefixPattern),
    gitHeadWatchInterval: config.get<number>("gitHeadWatchInterval", 1000),
  };
}

function updateCommitMessage(repo: Repository, config: ExtensionConfig, currentMessage?: string): void {
  const branch: string = repo.state.HEAD?.name ?? "";
  if (!branch) {
    return;
  }

  if (typeof currentMessage === 'undefined') {
    currentMessage = extractCurrentMessage(repo, config);
  }

  const updatedMessage = getCommitMessage(branch, currentMessage, config);

  if (repo.inputBox.value !== updatedMessage) {
    repo.inputBox.value = updatedMessage;
  }
}

function extractCurrentMessage(repo: Repository, config: ExtensionConfig): string {
  return repo.inputBox.value.replace(
    config.outdatedPrefixPattern,
    "$2"
  );
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
  const config = getExtensionConfig();

  const repoWatchers: RepositoryWatcher[] = [];

  const updateRepositoryWatchers = (newConfig: ExtensionConfig) => {
    for (const watcher of repoWatchers) {
      watcher.updateConfig(newConfig);
    }
  };

  const addRepoWatcher = (repo: Repository) => {
    const existingWatcher = repoWatchers.find(watcher => watcher.repo === repo);
    if (existingWatcher) {
      return;
    }
    const watcher = new RepositoryWatcher(repo, config, outputChannel);
    repoWatchers.push(watcher);
  };

  updateRepositoryWatchers(config);

  const configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("jira-commit-message")) {
      outputChannel.appendLine(`${LOG_PREFIX} Configuration changed, updating...`);
      config = getExtensionConfig();
      updateRepositoryWatchers(config);
    }
  });

  const repositorySubscription = git.onDidOpenRepository(addRepoWatcher);

  git.repositories.forEach(addRepoWatcher);

  context.subscriptions.push(
    configSubscription,
    repositorySubscription,
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
            updateCommitMessage(repo, config);
            outputChannel.appendLine(
              `${LOG_PREFIX} Commit message updated via command.`
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
