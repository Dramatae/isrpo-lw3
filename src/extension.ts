import * as vscode from 'vscode';
import { Finding, runRules } from './rules';

const SOURCE = 'Cat Linter';

// == Данные ==

// Одна найденная проблема в списке.
interface Issue {
  key: string; // уникальный ключ: файл | правило | текст строки | порядковый номер
  uri: vscode.Uri;
  finding: Finding;
  checked: boolean; // стоит ли галочка
}

// Элемент дерева: либо файл, либо проблема внутри файла.
type TreeNode =
  | { kind: 'file'; uri: vscode.Uri; count: number }
  | { kind: 'issue'; issue: Issue };

const issuesByFile = new Map<string, Issue[]>(); // файл -> его проблемы
const checkOverrides = new Map<string, boolean>(); // галочки, которые пользователь поставил/снял вручную
const diagnostics = vscode.languages.createDiagnosticCollection('cat-linter');
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let statusItem: vscode.StatusBarItem | undefined;

// == Настройки ==
function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('catlinter');
}

function disabledRules(): Set<string> {
  return new Set(config().get<string[]>('disabledRules', []));
}

// == Боковая панель ==
class IssueTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  refresh(): void {
    this.changeEmitter.fire();
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      return [...issuesByFile.entries()].map(([uri, list]) => ({
        kind: 'file' as const,
        uri: vscode.Uri.parse(uri),
        count: list.length,
      }));
    }
    if (node.kind === 'file') {
      return (issuesByFile.get(node.uri.toString()) ?? []).map((issue) => ({
        kind: 'issue' as const,
        issue,
      }));
    }
    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'file') {
      const name = node.uri.path.split('/').pop() ?? node.uri.path;
      const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `file:${node.uri.toString()}`;
      item.description = String(node.count);
      item.resourceUri = node.uri;
      item.iconPath = vscode.ThemeIcon.File;
      return item;
    }

    const { issue } = node;
    const f = issue.finding;
    const item = new vscode.TreeItem(`${f.line + 1}: ${f.title}`, vscode.TreeItemCollapsibleState.None);
    item.id = issue.key;
    item.description = f.fixTitle;
    item.tooltip = f.message;
    item.checkboxState = issue.checked
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.command = { command: 'catlinter.reveal', title: 'Показать в коде', arguments: [issue] };
    return item;
  }
}

const treeProvider = new IssueTreeProvider();

// == Лампочка ==
class CatFixProvider implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    doc: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const list = issuesByFile.get(doc.uri.toString()) ?? [];

    for (const diag of context.diagnostics) {
      if (diag.source !== SOURCE) {
        continue;
      }
      const issue = list.find(
        (i) =>
          i.finding.ruleId === diag.code &&
          i.finding.line === diag.range.start.line &&
          i.finding.startCol === diag.range.start.character
      );
      if (!issue) {
        continue;
      }
      const f = issue.finding;

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

function buildIssues(uri: vscode.Uri, lines: string[], findings: Finding[]): Issue[] {
  const uriKey = uri.toString();
  const seen = new Map<string, number>();
  return findings.map((f) => {
    const base = `${uriKey}|${f.ruleId}|${lines[f.line].trim()}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const key = `${base}|${n}`;
    return { key, uri, finding: f, checked: checkOverrides.get(key) ?? true };
  });
}

// Забываем галочки у проблем, которых больше нет
function pruneOverrides(uriKey: string): void {
  const alive = new Set((issuesByFile.get(uriKey) ?? []).map((i) => i.key));
  const prefix = `${uriKey}|`;
  for (const k of checkOverrides.keys()) {
    if (k.startsWith(prefix) && !alive.has(k)) {
      checkOverrides.delete(k);
    }
  }
}

function scanDocument(doc: vscode.TextDocument): void {
  // doc.isClosed: файл могли закрыть, пока ждал таймер
  if (!isCppDoc(doc) || doc.isClosed) {
    return;
  }
  const lines = doc.getText().split(/\r?\n/);
  const off = disabledRules(); // правила, отключённые в настройках
  const findings = runRules(lines, doc.fileName).filter((f) => !off.has(f.ruleId));
  const uriKey = doc.uri.toString();

  // Подчёркивания в редакторе
  diagnostics.set(doc.uri, findings.map(toDiagnostic));

  // Список для боковой панели (по умолчанию все галочки стоят)
  if (findings.length === 0) {
    issuesByFile.delete(uriKey);
  } else {
    issuesByFile.set(uriKey, buildIssues(doc.uri, lines, findings));
  }
  pruneOverrides(uriKey);
  treeProvider.refresh();
  updateStatus();
}

// Проверяем не на каждую букву, а через 300 мс после последней правки.
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

function updateStatus(): void {
  if (!statusItem) {
    return;
  }
  let total = 0;
  for (const list of issuesByFile.values()) {
    total += list.length;
  }
  statusItem.text = total === 0 ? '😺 Cat Linter' : `😿 ${total}`;
  statusItem.tooltip = total === 0 ? 'Ошибок нет — мур!' : `Найдено проблем: ${total}`;
}

// == Команды ==
async function fixSelected(): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  let count = 0;

  for (const list of issuesByFile.values()) {
    const taken: vscode.Range[] = []; // уже занятые места в этом файле
    for (const issue of list) {
      if (!issue.checked) {
        continue;
      }
      const f = issue.finding;
      const range = new vscode.Range(f.line, f.fix.startCol, f.line, f.fix.endCol);
      // Если два исправления задевают одно место, применяем только первое.
      if (taken.some((r) => r.intersection(range) !== undefined)) {
        continue;
      }
      taken.push(range);
      edit.replace(issue.uri, range, f.fix.newText);
      count++;
    }
  }

  if (count === 0) {
    vscode.window.showInformationMessage('Мяу! Нечего исправлять: отметьте галочками нужные пункты.');
    return;
  }
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    return;
  }

  vscode.window.showInformationMessage(`😺 Исправлено проблем: ${count}`);
}

function setAllChecked(value: boolean): void {
  for (const list of issuesByFile.values()) {
    for (const issue of list) {
      issue.checked = value;
      checkOverrides.set(issue.key, value);
    }
  }
  treeProvider.refresh();
}

async function reveal(issue: Issue): Promise<void> {
  const f = issue.finding;
  const doc = await vscode.workspace.openTextDocument(issue.uri);
  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Range(f.line, f.startCol, f.line, f.endCol),
  });
}

// == Запуск расширения ==
export function activate(context: vscode.ExtensionContext): void {
  const treeView = vscode.window.createTreeView('catlinter.issues', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusItem.command = 'workbench.view.extension.catlinter';
  statusItem.show();
  updateStatus();

  context.subscriptions.push(
    diagnostics,
    treeView,
    statusItem,

    // При выключении расширения гасим все ожидающие таймеры
    {
      dispose: () => {
        for (const t of timers.values()) {
          clearTimeout(t);
        }
        timers.clear();
      },
    },

    // Пользователь поставил или снял галочку
    treeView.onDidChangeCheckboxState((e) => {
      for (const [node, state] of e.items) {
        if (node.kind !== 'issue') {
          continue;
        }
        const checked = state === vscode.TreeItemCheckboxState.Checked;
        node.issue.checked = checked;
        checkOverrides.set(node.issue.key, checked);
      }
    }),

    // Когда проверять файлы
    vscode.workspace.onDidOpenTextDocument(scanDocument),
    vscode.workspace.onDidSaveTextDocument(scanDocument),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleScan(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const k = doc.uri.toString();
      const timer = timers.get(k);
      if (timer) {
        clearTimeout(timer); // иначе проверка сработает на уже закрытом файле
        timers.delete(k);
      }
      diagnostics.delete(doc.uri);
      issuesByFile.delete(k);
      pruneOverrides(k); // проблем у файла нет — забываем все его галочки
      treeProvider.refresh();
      updateStatus();
    }),

    // Если изменили список отключённых правил в настройках — проверяем всё заново
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('catlinter.disabledRules')) {
        vscode.workspace.textDocuments.forEach(scanDocument);
      }
    }),

    // Лампочка с быстрым исправлением
    vscode.languages.registerCodeActionsProvider(
      [{ language: 'cpp' }, { language: 'c' }],
      new CatFixProvider(),
      { providedCodeActionKinds: CatFixProvider.kinds }
    ),

    // Команды (их названия объявлены в package.json)
    vscode.commands.registerCommand('catlinter.fixSelected', fixSelected),
    vscode.commands.registerCommand('catlinter.selectAll', () => setAllChecked(true)),
    vscode.commands.registerCommand('catlinter.clearAll', () => setAllChecked(false)),
    vscode.commands.registerCommand('catlinter.reveal', reveal)
  );

  // Проверяем файлы, которые уже открыты
  vscode.workspace.textDocuments.forEach(scanDocument);
}

export function deactivate(): void {}