import * as vscode from 'vscode';
import { runRules } from './rules';

export function activate(_context: vscode.ExtensionContext): void {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const lines = editor.document.getText().split(/\r?\n/);
    const findings = runRules(lines, editor.document.fileName);
    console.log(`Cat Linter: найдено проблем — ${findings.length}`);
    for (const f of findings) {
      console.log(`  ${f.line + 1}: ${f.title} (${f.ruleId})`);
    }
  }
}

export function deactivate(): void {}