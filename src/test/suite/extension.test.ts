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
    await new Promise((resolve) => setTimeout(resolve, GIT_WAIT_INTERVAL));
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

      await updateConfig({
        commitMessageFormat: "${prefix} ${message}",
      });

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

  test("should not duplicate prefix with character class patterns", async function () {
    // Issue: https://github.com/kivicode/Jira-Commit-Message/issues/6
    await updateConfig({
      commitMessagePrefixPattern: "feature-([A-Z]+-\\d+)-.*",
      commitMessageFormat: "[${prefix}] ${message}",
    });
    const repo = gitApi.repositories[0];

    repo.inputBox.value = "Add new feature";
    await switchToBranch("feature-ABC-123-implement-login");
    await assertCommitMessage("[ABC-123] Add new feature");

    for (let i = 0; i < 3; i++) {
      await vscode.commands.executeCommand(
        "jira-commit-message.update-message"
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await assertCommitMessage("[ABC-123] Add new feature");

    repo.inputBox.value = "[ABC-123] Add new feature and fix tests";
    await vscode.commands.executeCommand("jira-commit-message.update-message");
    await assertCommitMessage("[ABC-123] Add new feature and fix tests");
  });

  test("should work with different character class patterns", async function () {
    // Issue: https://github.com/kivicode/Jira-Commit-Message/issues/6
    await updateConfig({
      commitMessagePrefixPattern: "([A-Z0-9]+-\\d+)-.*",
      commitMessageFormat: "${prefix}: ${message}",
    });
    const repo = gitApi.repositories[0];

    repo.inputBox.value = "Initial implementation";
    await switchToBranch("ABC1-456-feature");
    await assertCommitMessage("ABC1-456: Initial implementation");

    await vscode.commands.executeCommand("jira-commit-message.update-message");
    await vscode.commands.executeCommand("jira-commit-message.update-message");
    await assertCommitMessage("ABC1-456: Initial implementation");
  });

  test("should handle user modifying commit message with existing prefix", async function () {
    // Real scenario: User manually edits a commit message that already has a prefix
    await updateConfig({
      commitMessagePrefixPattern: "(PROJ-\\d+)-.*",
      commitMessageFormat: "[${prefix}] ${message}"
    });
    const repo = gitApi.repositories[0];

    repo.inputBox.value = "Initial work";
    await switchToBranch("PROJ-456-feature");
    await assertCommitMessage("[PROJ-456] Initial work");

    // User manually edits the commit message
    repo.inputBox.value = "[PROJ-456] Initial work with bug fixes and tests";

    // Extension should not interfere when user edits
    await vscode.commands.executeCommand("jira-commit-message.update-message");
    await assertCommitMessage("[PROJ-456] Initial work with bug fixes and tests");
  });

  test("should work with hyphenated project names", async function () {
    // Real scenario: Some teams use hyphenated project names like "MY-PROJECT-123"
    await updateConfig({
      commitMessagePrefixPattern: "([A-Z]+-[A-Z]+-\\d+)-.*",
      commitMessageFormat: "${prefix}: ${message}"
    });
    const repo = gitApi.repositories[0];

    repo.inputBox.value = "Add authentication";
    await switchToBranch("MY-PROJECT-789-auth-feature");
    await assertCommitMessage("MY-PROJECT-789: Add authentication");

    // Test multiple updates don't cause issues
    await vscode.commands.executeCommand("jira-commit-message.update-message");
    await assertCommitMessage("MY-PROJECT-789: Add authentication");
  });

  test("should preserve empty commit messages", async function () {
    // Real scenario: User wants to commit with an empty message (maybe for amending)
    await updateConfig({
      commitMessagePrefixPattern: "(TASK-\\d+)-.*",
      commitMessageFormat: "[${prefix}] ${message}"
    });
    const repo = gitApi.repositories[0];

    repo.inputBox.value = "";
    await switchToBranch("TASK-999-empty-commit");
    await assertCommitMessage("[TASK-999] ");
  });

  test("should handle switching between different branch types", async function () {
    // Real scenario: Developer switches between feature branches and main/master
    await updateConfig({
      commitMessagePrefixPattern: "(FEAT-\\d+)-.*",
      commitMessageFormat: "${prefix}: ${message}"
    });
    const repo = gitApi.repositories[0];

    // Start on feature branch
    repo.inputBox.value = "Add user login";
    await switchToBranch("FEAT-123-login");
    await assertCommitMessage("FEAT-123: Add user login");

    // Switch to main branch - should not modify commit message
    repo.inputBox.value = "Fix critical bug";
    await switchToBranch("main");
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(repo.inputBox.value, "Fix critical bug");

    // Switch back to feature branch - should add prefix again
    repo.inputBox.value = "Update login logic";
    await switchToBranch("FEAT-456-login-update");
    await assertCommitMessage("FEAT-456: Update login logic");
  });

  test("should handle messages with existing different prefixes", async function () {
    // Real scenario: User has a message with a prefix from a different format
    // Extension should NOT try to be smart about stripping unknown prefixes
    await updateConfig({
      commitMessagePrefixPattern: "(NEW-\\d+)-.*",
      commitMessageFormat: "[${prefix}] ${message}"
    });
    const repo = gitApi.repositories[0];

    // Start with a message that has a different prefix format
    repo.inputBox.value = "[OLD-123] Some existing work";
    await switchToBranch("NEW-789-refactor");

    // Should add the new prefix, keeping the old content as-is
    await assertCommitMessage("[NEW-789] [OLD-123] Some existing work");
  });

  test("should replace existing leading prefix when switching between matching branches", async function () {
    await updateConfig({
      commitMessagePrefixPattern: "(PP-\\d+)-.*",
      commitMessageFormat: "[${prefix}] ${message}",
    });
    const repo = gitApi.repositories[0];

    repo.inputBox.value = "Implement branch switch behavior";
    await switchToBranch("PP-101-first-branch");
    await assertCommitMessage("[PP-101] Implement branch switch behavior");

    await switchToBranch("PP-202-second-branch");
    await assertCommitMessage("[PP-202] Implement branch switch behavior");
  });

  test("should work with numeric-only prefixes", async function () {
    // Real scenario: Some teams use just numbers for tickets
    await updateConfig({
      commitMessagePrefixPattern: "(\\d+)-.*",
      commitMessageFormat: "#${prefix}: ${message}"
    });
    const repo = gitApi.repositories[0];

    repo.inputBox.value = "Fix validation error";
    await switchToBranch("12345-validation-fix");
    await assertCommitMessage("#12345: Fix validation error");

    // Test that it doesn't duplicate
    await vscode.commands.executeCommand("jira-commit-message.update-message");
    await assertCommitMessage("#12345: Fix validation error");
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
      "commitMessageFormat",
      extensionConfig.commitMessageFormat
    );
  }
});
