import * as vscode from 'vscode';
import { Finding, runRules } from './rules';

const SOURCE = 'Cat Linter';

// Коллекция для подчеркиваний в редакторе
const diagnostics = vscode.languages.createDiagnosticCollection('cat-linter');
// Таймеры для отложенной проверки
const timers = new Map<string, ReturnType<typeof setTimeout>>();

// == Лампочка ==
class CatFixProvider implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    doc: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const findings = runRules(doc.getText().split(/\r?\n/), doc.fileName);

    for (const diag of context.diagnostics) {
      if (diag.source !== SOURCE) {
        continue;
      }
      const f = findings.find(
        (x) =>
          x.ruleId === diag.code &&
          x.line === diag.range.start.line &&
          x.startCol === diag.range.start.character
      );
      if (!f) {
        continue;
      }

      const action = new vscode.CodeAction(`🐱 ${f.fixTitle}`, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diag];
      action.isPreferred = true;
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(
        doc.uri,
        new vscode.Range(f.line, f.fix.startCol, f.line, f.fix.endCol),
        f.fix.newText
      );
      actions.push(action);
    }
    return actions;
  }
}

// == Проверка файлов ==
function isCppDoc(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'cpp' || doc.languageId === 'c';
}

function toDiagnostic(f: Finding): vscode.Diagnostic {
  const range = new vscode.Range(f.line, f.startCol, f.line, f.endCol);
  const severity =
    f.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
  const d = new vscode.Diagnostic(range, f.message, severity);
  d.source = SOURCE;
  d.code = f.ruleId;
  return d;
}

function scanDocument(doc: vscode.TextDocument): void {
  if (!isCppDoc(doc)) {
    return;
  }
  const lines = doc.getText().split(/\r?\n/);
  const findings = runRules(lines, doc.fileName);
  diagnostics.set(doc.uri, findings.map(toDiagnostic));
}

// Запускаем проверку через 300 мс после последней правки
function scheduleScan(doc: vscode.TextDocument): void {
  if (!isCppDoc(doc)) {
    return;
  }
  const k = doc.uri.toString();
  const old = timers.get(k);
  if (old) {
    clearTimeout(old);
  }
  timers.set(
    k,
    setTimeout(() => {
      timers.delete(k);
      scanDocument(doc);
    }, 300)
  );
}

// == Запуск расширения ==
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    diagnostics,

    vscode.workspace.onDidOpenTextDocument(scanDocument),
    vscode.workspace.onDidSaveTextDocument(scanDocument),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleScan(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.delete(doc.uri);
    }),

    vscode.languages.registerCodeActionsProvider(
      [{ language: 'cpp' }, { language: 'c' }],
      new CatFixProvider(),
      { providedCodeActionKinds: CatFixProvider.kinds }
    )
  );

  vscode.workspace.textDocuments.forEach(scanDocument);
}

export function deactivate(): void {}