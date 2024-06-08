import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitExtension, Repository } from './git';

interface ExtensionConfig {
	commitMessagePrefixPattern: RegExp;
	commitMessageFormat: string;
	gitHeadWatchInterval: number;
	outdatedPrefixPattern: RegExp;
}

function getExtensionConfig(): ExtensionConfig {
	const config = vscode.workspace.getConfiguration('jira-commit-message');
	const tagPattern = config.get<string>('commitMessagePrefixPattern', '(ML-\\d+)-.*');
	const msgFormat = config.get<string>("commitMessageFormat", "[${prefix}] ${message}");

	const match = tagPattern.match(/\(([^)]+)\)/);
	const prefixPattern = match ? match[1] : tagPattern;
	const outdatedPrefixPattern: string = msgFormat
		.replace('${prefix}', `(${prefixPattern})`)
		.replace('${message}', '(.*)')
		.replace(/[\[\]]/g, '\\$&')
		.replace(/\$/g, '\\$');

	return {
		commitMessagePrefixPattern: new RegExp(tagPattern),
		commitMessageFormat: msgFormat,
		outdatedPrefixPattern: new RegExp(outdatedPrefixPattern),
		gitHeadWatchInterval: config.get<number>('gitHeadWatchInterval', 1000),
	};
}

function updateCommitMessage(repo: Repository) {
	const config = getExtensionConfig();
	const branch: string = repo.state.HEAD?.name ?? "";

	if (config.outdatedPrefixPattern.test(repo.inputBox.value)) {
		repo.inputBox.value = repo.inputBox.value.replace(config.outdatedPrefixPattern, "$2");
	}

	repo.inputBox.value = getCommitMessage(branch, repo.inputBox.value, config);
}

function getCommitMessage(branch: string, currentMessage: string, config: ExtensionConfig): string {
    if (!config.commitMessagePrefixPattern.test(branch)) {
        return currentMessage;
    }
    const prefixMatch = branch.match(config.commitMessagePrefixPattern);
    if (!prefixMatch) {
        return currentMessage;
    }
    const prefix = prefixMatch[1];

    if (currentMessage) {
        const prefixOldBranchMatch = currentMessage.match(config.commitMessagePrefixPattern);
        if (prefixOldBranchMatch) {
            const prefixOldBranch = prefixOldBranchMatch[1]
            if (prefix != prefixOldBranch) {
                return currentMessage.replace(prefixOldBranch, prefix)
            } else {
                return currentMessage
            }
        }
    }

    const formattedMessage = config.commitMessageFormat
        .replace('${prefix}', prefix)
        .replace('${message}', currentMessage);
    return formattedMessage;
}


export function activate(context: vscode.ExtensionContext): void {
	const gitExtension: GitExtension | undefined = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
	if (!gitExtension) {
		vscode.window.showErrorMessage("Unable to load the Git extension");
		return;
	}
	const git = gitExtension.getAPI(1);
	const config = getExtensionConfig();

	git.repositories.forEach(repo => {
		const gitDir = path.join(repo.rootUri.fsPath, '.git');
		const gitHeadPath = path.join(gitDir, 'HEAD');
		// vscode.window.showInformationMessage("Watching " + gitHeadPath);

		fs.readFile(gitHeadPath, 'utf8', (err, initialHeadContent) => {
			if (err) {
				vscode.window.showErrorMessage('Error reading .git/HEAD: ' + err);
				return;
			}

			const initialRef = initialHeadContent.startsWith('ref:') ? initialHeadContent.split(' ')[1].trim() : null;
			const refFilePath = initialRef ? path.join(gitDir, initialRef) : null;

			fs.watchFile(gitHeadPath, { interval: config.gitHeadWatchInterval }, (curr, prev) => {
				if (curr.mtime !== prev.mtime) {
					updateCommitMessage(repo);
				}
			});

			if (!refFilePath) { return; }
			fs.watchFile(refFilePath, { interval: config.gitHeadWatchInterval }, (curr, prev) => {
				if (curr.mtime !== prev.mtime) {
					updateCommitMessage(repo);
				}
			});
		});

		updateCommitMessage(repo);
	});
	context.subscriptions.push(vscode.commands.registerCommand('jira-commit-message.update-message', async (uri?) => {
		git.repositories.forEach(updateCommitMessage);
	}));
}

export function deactivate(): void { }
