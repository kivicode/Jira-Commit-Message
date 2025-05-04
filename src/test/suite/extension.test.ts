import * as assert from "assert";
import * as vscode from "vscode";

import { before, suite, test, beforeEach } from "mocha";
import { GitExtension } from "../../git";

const disableTimeouts = process.env.DISABLE_TIMEOUTS === "true";

const GIT_WAIT_INTERVAL = 1500;

suite("Jira Commit Message Extension", function () {
  this.timeout(disableTimeouts ? 0 : 30000);
  let gitExtension: vscode.Extension<any>;
  let gitApi: ReturnType<GitExtension["getAPI"]>;

  async function initializeGitRepository(workspaceFolder: vscode.Uri) {
    if (gitApi.state === "uninitialized") {
      await new Promise((resolve) => {
        gitApi.onDidChangeState(resolve);
      });
    }

    if (gitApi.repositories.length === 0) {
      const p = new Promise((resolve, _) => {
        gitApi.onDidOpenRepository(async (repo) => {
          await repo.setConfig("user.name", "Test User");
          await repo.setConfig("user.email", "test@example.com");

          const readmeUri = vscode.Uri.joinPath(workspaceFolder, ".gitignore");
          // Must ignore workspace settings, otherwise we can't switch branches because of uncommitted changes
          // if the settings are changed.
          await vscode.workspace.fs.writeFile(
            readmeUri,
            Buffer.from(".vscode/")
          );

          await repo.add([readmeUri.fsPath]);
          await repo.commit("Initial commit");

          resolve(true);
        });
      });

      await vscode.commands.executeCommand("git.init", workspaceFolder);
      await p;
    }
  }

  async function switchToBranch(branchName: string) {
    const repo = gitApi.repositories[0];
    const branches = await repo.getBranches({ remote: false });

    if (branches.every((r) => r.name !== branchName)) {
      await repo.createBranch(branchName, false);
    }
    await repo.checkout(branchName);

    // Wait for the extension to catch up
    await new Promise((resolve) =>
      setTimeout(resolve, GIT_WAIT_INTERVAL)
    );
  }

  before(async function () {
    try {
      // Not necessary, because it activates on its own, but it will fail if the extension is not available.
      const jiraExtension = vscode.extensions.getExtension(
        "KiviCode.jira-commit-message"
      )!;

      await jiraExtension.activate();
      gitExtension = vscode.extensions.getExtension("vscode.git")!;

      const git: GitExtension = gitExtension.exports;
      gitApi = git.getAPI(1);

      const workspaceFolders = vscode.workspace.workspaceFolders;

      if (workspaceFolders === undefined) {
        throw new Error("unexpected");
      }

      await initializeGitRepository(workspaceFolders[0].uri);
    } catch (e) {
      console.error(e);
    }
  });

  beforeEach(async function () {
    const repo = gitApi.repositories[0];
    repo.inputBox.value = "";

    await switchToBranch("main");
    await vscode.commands.executeCommand("workbench.view.scm");
  });

  test("should update commit message when switching to a branch matching prefix pattern", async function () {
    // Must set patters at start to avoid patterns leaking in from other tests
    await updateConfig({
      commitMessagePrefixPattern: "(PP-\\d+)-.*",
    });
    const repo = gitApi.repositories[0];

    repo.inputBox.value = "Test feature implementation";
    await switchToBranch("PP-716-my-branch");
    await assertCommitMessage("PP-716 Test feature implementation");
  });

  test("should not modify commit message for branches not matching prefix pattern", async function () {
    // Must set patters at start to avoid patterns leaking in from other tests
    await updateConfig({
      commitMessagePrefixPattern: "(PP-\\d+)-.*",
    });
    const repo = gitApi.repositories[0];

    repo.inputBox.value = "Test non matching branch commit";
    await switchToBranch("XY-7160-my-branch");

    // This is a bit annoying, because we can't test for anything;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(repo.inputBox.value, "Test non matching branch commit");
  });

  test("should update commit message when configuration is updated", async function () {
    const repo = gitApi.repositories[0];

    repo.inputBox.value = "My commit";
    await switchToBranch("BY-716-my-branch");
    await updateConfig({
      commitMessagePrefixPattern: "(BY-\\d+)-.*",
    });
    await assertCommitMessage("BY-716 My commit");
  });

  async function assertCommitMessage(expectedMessage: string) {
    const repo = gitApi.repositories[0];
    const timeout = disableTimeouts ? Infinity : 2000;
    const interval = 25;
    const startTime = Date.now();

    await new Promise<void>((resolve) => {
      const checkMessage = () => {
        if (repo.inputBox.value === expectedMessage) {
          resolve();
        } else if (Date.now() - startTime >= timeout) {
          resolve();
        } else {
          setTimeout(checkMessage, interval);
        }
      };
      checkMessage();
    });

    assert.equal(repo.inputBox.value, expectedMessage);
  }

  interface ExtensionConfig {
    commitMessagePrefixPattern?: string;
    gitHeadWatchInterval?: number;
    commitMessageFormat?: string;
  }

  async function updateConfig(extensionConfig: ExtensionConfig) {
    const config = vscode.workspace.getConfiguration("jira-commit-message");

    const updateIfNecessary = async (section: string, newValue?: any) => {
      if (newValue) {
        const currentValue = await config.get(section);
        if (currentValue !== newValue) {
          await config.update(section, newValue);
        }
      }
    };

    updateIfNecessary(
      "commitMessagePrefixPattern",
      extensionConfig.commitMessagePrefixPattern
    );

    updateIfNecessary(
      "gitHeadWatchInterval",
      extensionConfig.gitHeadWatchInterval
    );

    updateIfNecessary(
      "commitMessageFormat",
      extensionConfig.commitMessageFormat
    );
  }
});
