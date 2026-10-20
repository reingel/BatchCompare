import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { parse } from 'jsonc-parser/lib/esm/main.js';
import { Registry, parseRawGrammar, INITIAL, IRawTheme } from 'vscode-textmate';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';

interface GrammarContribution { language?: string; scopeName: string; path: string; injectTo?: string[] }
interface ThemeContribution { id?: string; label: string; path: string }
interface ThemeData { include?: string; tokenColors?: IRawTheme['settings'] | string; settings?: IRawTheme['settings']; colors?: Record<string, string> }
export interface SyntaxData {
  colors: string[];
  tokens: number[][][];
  editor: { fontFamily?: string; fontSize?: number; fontWeight?: string; fontLigatures?: boolean | string;
    lineHeight?: number; tabSize?: number; renderWhitespace?: string };
}
let wasm: Promise<void> | undefined;
function editorOptions(): SyntaxData['editor'] {
  const editor = vscode.workspace.getConfiguration('editor');
  return {
    fontFamily: editor.get<string>('fontFamily'), fontSize: editor.get<number>('fontSize'),
    fontWeight: editor.get<string>('fontWeight'), fontLigatures: editor.get<boolean | string>('fontLigatures'),
    lineHeight: editor.get<number>('lineHeight'),
    tabSize: editor.get<number>('tabSize'), renderWhitespace: editor.get<string>('renderWhitespace'),
  };
}
async function readTheme(filename: string, seen = new Set<string>()): Promise<ThemeData> {
  if (seen.has(filename)) return {};
  seen.add(filename);
  const source = await fs.readFile(filename, 'utf8');
  const own: ThemeData = filename.endsWith('.tmTheme')
    ? parseRawGrammar(source, filename) as unknown as ThemeData : parse(source);
  const parent = own.include ? await readTheme(path.resolve(path.dirname(filename), own.include), seen) : {};
  const tokens = typeof own.tokenColors === 'string'
    ? (await readTheme(path.resolve(path.dirname(filename), own.tokenColors), seen)).tokenColors
    : own.tokenColors ?? own.settings;
  return { tokenColors: [...(Array.isArray(parent.tokenColors) ? parent.tokenColors : []), ...(Array.isArray(tokens) ? tokens : [])],
    colors: { ...parent.colors, ...own.colors } };
}

/** Use installed VS Code TextMate grammars and the selected theme's actual token rules. */
export async function getFileSyntax(context: vscode.ExtensionContext, uris: vscode.Uri[], texts: string[],
  onProgress?: (completed: number, total: number) => void, tokenize = true): Promise<SyntaxData | undefined> {
  if (!vscode.extensions) return undefined;
  if (!tokenize) return { colors: [], tokens: [], editor: editorOptions() };
  const grammars = new Map<string, { filename: string; contribution: GrammarContribution }>();
  const languages = new Map<string, string>();
  const selectedTheme = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
  let theme: ThemeData = {};
  for (const extension of vscode.extensions.all) {
    const contributions = extension.packageJSON.contributes;
    for (const grammar of (contributions?.grammars ?? []) as GrammarContribution[]) {
      grammars.set(grammar.scopeName, { filename: path.resolve(extension.extensionPath, grammar.path), contribution: grammar });
      if (grammar.language) languages.set(grammar.language, grammar.scopeName);
    }
    for (const candidate of (contributions?.themes ?? []) as ThemeContribution[]) {
      if (candidate.id === selectedTheme || candidate.label === selectedTheme) {
        try { theme = await readTheme(path.resolve(extension.extensionPath, candidate.path)); } catch { /* use base colors */ }
      }
    }
  }
  const custom = vscode.workspace.getConfiguration('editor').get<Record<string, unknown>>('tokenColorCustomizations', {});
  const specific = custom[`[${selectedTheme}]`] as Record<string, unknown> | undefined;
  const kind = vscode.window.activeColorTheme?.kind;
  const dark = kind !== vscode.ColorThemeKind.Light && kind !== vscode.ColorThemeKind.HighContrastLight;
  const colorOverrides = vscode.workspace.getConfiguration('workbench').get<Record<string, unknown>>('colorCustomizations', {});
  const themedOverrides = colorOverrides[`[${selectedTheme}]`] as Record<string, unknown> | undefined;
  for (const customization of [colorOverrides, themedOverrides ?? {}]) {
    for (const key of ['editor.foreground', 'editor.background']) {
      if (typeof customization[key] === 'string') theme.colors = { ...theme.colors, [key]: customization[key] as string };
    }
  }
  const settings: NonNullable<IRawTheme['settings']> = [{ settings: {
    foreground: theme.colors?.['editor.foreground'] ?? (dark ? '#d4d4d4' : '#333333'),
    background: theme.colors?.['editor.background'] ?? (dark ? '#1e1e1e' : '#ffffff'),
  } }, ...(Array.isArray(theme.tokenColors) ? theme.tokenColors : [])];
  const scopes: Record<string, string> = { comments: 'comment', strings: 'string', keywords: 'keyword',
    numbers: 'constant.numeric', types: 'entity.name.type', functions: 'entity.name.function', variables: 'variable' };
  for (const customization of [custom, specific ?? {}]) {
    for (const [key, scope] of Object.entries(scopes)) {
      if (typeof customization[key] === 'string') settings.push({ scope, settings: { foreground: customization[key] as string } });
    }
    if (Array.isArray(customization.textMateRules)) settings.push(...customization.textMateRules);
  }
  wasm ??= fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'media', 'onig.wasm').fsPath)
    .then(bytes => loadWASM(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  await wasm;
  const registry = new Registry({
    theme: { settings },
    onigLib: Promise.resolve({ createOnigScanner: patterns => new OnigScanner(patterns), createOnigString: text => new OnigString(text) }),
    loadGrammar: async scope => {
      const grammar = grammars.get(scope);
      return grammar ? parseRawGrammar(await fs.readFile(grammar.filename, 'utf8'), grammar.filename) : null;
    },
    getInjections: scope => [...grammars].filter(([, grammar]) => grammar.contribution.injectTo?.includes(scope)).map(([name]) => name),
  });
  try {
    const tokens: number[][][] = [];
    const sourceLines = texts.map(text => text.replace(/\r\n?/g, '\n').split('\n'));
    const total = sourceLines.reduce((sum, lines) => sum + lines.length, 0);
    let completed = 0;
    onProgress?.(0, total);
    for (let i = 0; i < texts.length; i++) {
      const document = await vscode.workspace.openTextDocument(uris[i]);
      const scope = languages.get(document.languageId);
      const grammar = scope ? await registry.loadGrammar(scope) : null;
      let state = INITIAL;
      const lines = sourceLines[i];
      const tokenized: number[][] = [];
      for (let line = 0; line < lines.length; line++) {
        if (!grammar) tokenized.push([0, 0]);
        else {
          const result = grammar.tokenizeLine2(lines[line], state, 20);
          state = result.ruleStack;
          tokenized.push(Array.from(result.tokens));
        }
        // Let the extension host process input while tokenizing large files.
        completed++;
        if (completed % 200 === 0 || completed === total) {
          onProgress?.(completed, total);
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
      tokens.push(tokenized);
    }
    return { colors: registry.getColorMap(), tokens, editor: editorOptions() };
  } finally { registry.dispose(); }
}
