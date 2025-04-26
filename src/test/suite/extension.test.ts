import * as assert from 'assert';
import * as vscode from 'vscode';

import { after, before, suite, test, beforeEach } from 'mocha';
import { GitExtension } from '../../git';

const isDebugMode = process.env.DEBUG === 'true';

suite('Jira Commit Message Extension', function() {
  this.timeout(isDebugMode ? Infinity : 30000);
  let workspaceFolder: vscode.Uri;
  let gitExtension: vscode.Extension<any>;
  let jiraExtension: vscode.Extension<any>;
  let gitApi: ReturnType<GitExtension['getAPI']>;

  async function initializeGitRepository(workspaceFolder: vscode.Uri) {
    if (gitApi.repositories.length === 0) {
      const p = new Promise((resolve, _) => {
        gitApi.onDidOpenRepository(async repo => {
          await repo.setConfig('user.name', 'Test User');
          await repo.setConfig('user.email', 'test@example.com');
          
          const readmeUri = vscode.Uri.joinPath(workspaceFolder, 'README.md');
          await vscode.workspace.fs.writeFile(readmeUri, Buffer.from('# Test Project'));
          
          await repo.add([readmeUri.fsPath]);
          await repo.commit('Initial commit');
          
          resolve(true);
        });
      });
    
      await vscode.commands.executeCommand('git.init', workspaceFolder);
      return p;
    }
  }

    async function switchToBranch(branchName: string) {
      const repo = gitApi.repositories[0];
      const branches = await repo.getBranches({remote: false});

      if (branches.every(r => r.name !== branchName)) {
        await repo.createBranch(branchName, false);
      }
      await repo.checkout(branchName);
    }

  before(async function() {
    try {
      gitExtension = vscode.extensions.getExtension('vscode.git')!;
      const git: GitExtension = gitExtension.exports;
      gitApi = git.getAPI(1);
      jiraExtension = vscode.extensions.getExtension("KiviCode.jira-commit-message")!;

      await jiraExtension.activate();
  
      const config = vscode.workspace.getConfiguration('jira-commit-message');
      await config.update(
        'commitMessagePrefixPattern',
        '(PP-\\d+)-.*',
        vscode.ConfigurationTarget.Workspace
      );
      await config.update(
        'commitMessageFormat',
        '${prefix} ${message}',
        vscode.ConfigurationTarget.Workspace
      );

      await config.update('gitHeadWatchInterval', 50, vscode.ConfigurationTarget.Workspace);

      const workspaceFolders = vscode.workspace.workspaceFolders;

      if (workspaceFolders === undefined) {
        throw new Error("unexpected");
      }
      workspaceFolder = workspaceFolders[0].uri;
  
      await initializeGitRepository(workspaceFolders[0].uri);
    } catch (e) {
      console.error(e);
    }
  });

    beforeEach(async function() {
      const repo = gitApi.repositories[0];
      repo.inputBox.value = '';
    });

  test('should update commit message when switching to a branch matching prefix pattern', async function() {
    const repo = gitApi.repositories[0];
    await vscode.commands.executeCommand('workbench.view.scm');
    await repo.checkout('main');

    repo.inputBox.value = 'Test feature implementation';

    await switchToBranch('PP-716-my-branch');

    await assertCommitMessage("PP-716 Test feature implementation");
  });

  async function assertCommitMessage(expectedMessage: string) {
    const repo = gitApi.repositories[0];
    const timeout = isDebugMode ? Infinity : 50000;
    const interval = 50;
    const startTime = Date.now();
  
    return new Promise<void>((resolve, reject) => {
      const checkMessage = () => {
        if (repo.inputBox.value === expectedMessage) {
          resolve();
        } else if (Date.now() - startTime >= timeout) {
          reject(new Error('Expected commit message not found within the timeout period'));
        } else {
          setTimeout(checkMessage, interval);
        }
      };
      checkMessage();
    });
  }

  test.skip('should not modify commit message for branches not matching prefix pattern', async function() {
    const repo = gitApi.repositories[0];

    await repo.checkout('main');

    await new Promise(resolve => setTimeout(resolve, 2000));

    const originalMessage = 'Test main branch commit';

    await new Promise(resolve => setTimeout(resolve, 1000));

    const currentMessage = repo.inputBox.value;
    assert.strictEqual(
      currentMessage,
      originalMessage,
      'Commit message should not be modified for non-matching branches'
    );
  });

  after(async function() {
    // await vscode.commands.executeCommand('workbench.action.closeFolder');
    
    // try {
    //   await vscode.workspace.fs.delete(workspaceFolder, { 
    //     recursive: true, 
    //     useTrash: false 
    //   });
    // } catch (err) {
    //   console.warn('Could not delete test workspace', err);
    // }
  });
});
