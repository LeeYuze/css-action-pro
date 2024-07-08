import * as vscode from "vscode";
import { readFileSync, readdirSync, statSync } from "fs";
import path, { join } from "path";
import { render } from "ejs";
import tinycolor from "tinycolor2";

enum BultinTemplateVar {
  remResult = "_REM_RESULT_",
  varName = "_VAR_NAME_",
  matchedText = "_MATCHED_TEXT_",
}
let workbenchConfig: vscode.WorkspaceConfiguration;
let variablesDirectory: string | undefined;
let variablesFilePaths: string[] | undefined;
let variableMapper = new Map<string, Set<string>>();
let rootFontSize: number;
let pxReplaceOptions: string[];
let colorReplaceOptions: string[];
let diagnosticCollection: vscode.DiagnosticCollection;
let isAutoReplace: boolean;

function normalizeSizeValue(str: string) {
  const sizeReg = /\b\d+(px|rem|em)\b/g;
  const result = str.toLowerCase().match(sizeReg);
  if (result) {
    return result.join(" ");
  } else {
    return null;
  }
}

function normalizeColorValue(str: string) {
  if (str) {
    // fix: rgba以%作为单位时匹配错误的问题
    str = str.replace(/(\d+(\.\d+)?)%/, (match, p1) =>
      String(parseFloat(p1) / 100)
    );

    const color = tinycolor(str);

    return color.isValid() ? color.toHex8String() : null;
  } else {
    return null;
  }
}

/**
 * 找到哪几行是以less和:root形式命名的变量
 * @param text
 * @returns
 */
function objectVariableLineMap(text: string, offsetLineNumber: number = 0) {
  const textSplit = text.split("\n");

  // 记录对象定义遍历时，这个对象所在的行数
  const recordObjectVariableLineNumber: Record<
    string,
    { start: number; end: number; isCss: boolean }
  > = {};
  let currentObjectName = "";

  for (let lineNumber = 0; lineNumber < textSplit.length; lineNumber++) {
    const textLineTrim = textSplit[lineNumber].trim();
    // console.log(textLineTrim);

    if (
      (textLineTrim.startsWith("@") || textLineTrim.startsWith(":")) &&
      textLineTrim.endsWith("{")
    ) {
      let isCss = false;
      //@bg: { -> ['@bg' , ' {']
      let [objectName] = textLineTrim.split(":");

      // 遇到:root的情况
      if (textLineTrim.startsWith(":")) {
        objectName = textLineTrim
          .slice(0, textLineTrim.lastIndexOf("{"))
          .trim();
        isCss = true;
      }

      currentObjectName = objectName;

      if (!recordObjectVariableLineNumber[currentObjectName]) {
        recordObjectVariableLineNumber[currentObjectName] = {
          start: -1,
          end: -1,
          isCss, // 是不是css的全局 :root
        };
      }

      recordObjectVariableLineNumber[currentObjectName].start =
        lineNumber + offsetLineNumber;
    }
    if (currentObjectName && textLineTrim.includes("}")) {
      recordObjectVariableLineNumber[currentObjectName].end =
        lineNumber + offsetLineNumber;
      currentObjectName = "";
    }
  }

  return recordObjectVariableLineNumber;
}

/**
 * 删除Map中，less文件下已注释的变量
 * @param text 文件内容
 */
function removeInvalidVariablesWithLess(
  varMapper: Map<string, Set<string>>,
  text: string
) {
  const textSplit = text.split("\n");

  const objectVariableLineNumber = objectVariableLineMap(text);

  for (let lineNumber = 0; lineNumber < textSplit.length; lineNumber++) {
    const textLineTrim = textSplit[lineNumber].trim();
    if (textLineTrim.startsWith("//")) {
      const textLineWithoutSymbol = textLineTrim
        .replace(/^\/\//, "")
        .trimStart();

      let [key, value] = textLineWithoutSymbol.split(":");
      key = key.trim();
      if (!value) {
        continue;
      }

      value = value.replace(";", "").trim();
      const normalizedValue =
        normalizeSizeValue(value) || normalizeColorValue(value) || value || "";

      const varibalesSet = varMapper.get(normalizedValue);

      for (const ojectVariableKey of Object.keys(objectVariableLineNumber)) {
        const ojectVariableValue = objectVariableLineNumber[ojectVariableKey];
        if (
          ojectVariableValue.start < lineNumber &&
          lineNumber < ojectVariableValue.end
        ) {
          let removeKey = `${ojectVariableKey}[${key}]`;
          if (ojectVariableValue.isCss) {
            removeKey = `var(${key})`;
          }
          varibalesSet?.delete(removeKey);
        }
      }

      varibalesSet?.delete(key);
    }
  }
}

function getVariablesMapper(paths: string[]) {
  const varMapper = new Map<string, Set<string>>();
  try {
    for (const path of paths) {
      const text = readFileSync(path, { encoding: "utf8" });
      const objectMatches = text.matchAll(
        /((?:\$|@|--)[\w-]+)\s*:\s*{([^}]+)}/gi
      );
      const variableMatches = text.matchAll(
        /((?:\$|@|--)[\w-]+)\s*:[ \t]*([^;\n]+)/gi
      );

      if (objectMatches) {
        for (const match of objectMatches) {
          const [fullMatch, objectVarName, objectVarBody] = match;

          // 处理对象形式的变量
          const objectVarNameWithoutSymbol = objectVarName.replace(/[@$]/, "");
          const objectMatches = objectVarBody.matchAll(
            /([\w-]+)\s*:\s*([^;\n]+);?/gi
          );

          for (const objectMatch of objectMatches) {
            const [key, value] = [objectMatch[1], objectMatch[2]];
            // 构建变量名格式为 @bg[key]
            const variableName = `@${objectVarNameWithoutSymbol}[${key}]`;

            // 将变量值存储到 varMapper 中
            const normalizedValue =
              normalizeSizeValue(value) ||
              normalizeColorValue(value) ||
              value ||
              "";

            if (!varMapper.get(normalizedValue)) {
              varMapper.set(normalizedValue, new Set());
            }
            varMapper.get(normalizedValue)!.add(variableName);
          }
        }
      }
      if (variableMatches) {
        for (const match of variableMatches) {
          let [varName, varValue] = [match[1], match[2]];
          // if (varValue[0] !== "#") {
          //   continue;
          // }
          varValue =
            normalizeSizeValue(varValue) ||
            normalizeColorValue(varValue) ||
            varValue ||
            "";

          if (varName.startsWith("--")) {
            varName = `var(${varName})`;
          }
          if (!varMapper.get(varValue)) {
            varMapper.set(varValue, new Set());
          }
          varMapper.get(varValue)!.add(varName);
        }
      }
      // 找出所有前面带//的注释变量，将它在varMapper中删除
      removeInvalidVariablesWithLess(varMapper, text);
    }

    return varMapper;
  } catch (error) {
    console.log(error);

    return new Map();
  }
}

const renderVarNamesTpl = (
  tplString: string,
  varNames: Array<string>,
  context: any
) => {
  return varNames.map((varName) => {
    return render(tplString, {
      [BultinTemplateVar.varName]: varName,
      ...context,
    });
  });
};

const renderOptions = (
  optionTpls: string[],
  varNames: Set<string>,
  context: any
) => {
  let result: string[] = [];
  for (const option of optionTpls) {
    if (option.includes(BultinTemplateVar.varName)) {
      result = result.concat(
        renderVarNamesTpl(option, Array.from(varNames), context)
      );
    } else {
      result.push(render(option, context));
    }
  }
  return result;
};

export async function showQuickPick() {
  const quickPick = vscode.window.createQuickPick();
  quickPick.matchOnDescription = true;
  quickPick.ignoreFocusOut = true;
  quickPick.placeholder = "Search var name and value";
  const options: vscode.QuickPickItem[] = [];
  variableMapper.forEach((values, key) => {
    options.push(
      ...Array.from(values).map((i) => ({ label: i, description: key }))
    );
  });

  quickPick.items = options;
  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();

  quickPick.onDidChangeSelection((i) => {
    quickPick.hide();
    const selected = i[0];
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const text = selected.label;
    editor.edit((textEditorEdit) =>
      editor.selections.forEach((selection) =>
        textEditorEdit.replace(selection, text)
      )
    );
  });
}

function loadVariables() {
  let allVariableFiles: string[] = [];
  variableMapper = new Map<string, Set<string>>();
  if (
    variablesDirectory &&
    vscode.workspace.workspaceFolders &&
    vscode.workspace.workspaceFolders.length > 0
  ) {
    const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const fullDirectoryPath = path.join(workspacePath, variablesDirectory);
    const extensions = [".scss", ".css", ".less"];
    allVariableFiles = getAllFilesInDirectory(fullDirectoryPath, extensions);
  }

  if (variablesFilePaths && variablesFilePaths.length > 0) {
    const workspacePath = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const fullFilePaths = variablesFilePaths.map((filePath) =>
      path.join(workspacePath, filePath)
    );
    allVariableFiles = allVariableFiles.concat(fullFilePaths);
  }

  if (allVariableFiles.length > 0) {
    variableMapper = getVariablesMapper(allVariableFiles);
  } else {
    // vscode.window.showErrorMessage("No variable files or directories are set.");
  }
}
function getAllFilesInDirectory(dir: string, extensions: string[]): string[] {
  let results: string[] = [];
  const list = readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllFilesInDirectory(filePath, extensions));
    } else if (extensions.some((ext) => filePath.endsWith(ext))) {
      results.push(filePath);
    }
  });
  return results;
}

function diagnosticsCore(
  document: vscode.TextDocument,
  callback: (payload: {
    normalizedColor: string;
    colorValue: string;
    range: vscode.Range;
  }) => void
) {
  let text = document.getText();

  // console.log(text);

  let textSplit = text.split("\n");
  // console.log(textSplit);

  let styleLinenumber = 0;

  // 每一行的尾部的index
  // <style lang="less" scoped> 26 实际上显示27 因为算上换行
  let textSplitEndIndex = 0;
  let textSplitEndIndexArr = [];
  let textSplitEndIndexArrIndex = 0;
  // vue只检查<style></style>部分
  if (document.languageId === "vue") {
    text = text.slice(text.indexOf("<style"), text.lastIndexOf("</style>"));

    for (let lineNumber = 0; lineNumber < textSplit.length; lineNumber++) {
      const textLine = textSplit[lineNumber];
      const pattern = /^(.*<style\b[^>]*>.*)$/;

      if (pattern.test(textLine)) {
        styleLinenumber = lineNumber;
        break;
      }
      textSplitEndIndex += textLine.length + 1;
      textSplitEndIndexArr.push(textSplitEndIndex);
      textSplitEndIndexArrIndex += 1;
    }
  }

  textSplit = text.split("\n");
  try {
    const objectVariableLineNumber = objectVariableLineMap(
      text,
      styleLinenumber
    );
    for (let lineNumber = 0; lineNumber < textSplit.length; lineNumber++) {
      const textLine = textSplit[lineNumber];
      textSplitEndIndex += textLine.length + 1;
      textSplitEndIndexArr.push(textSplitEndIndex);
      textSplitEndIndexArrIndex += 1;
      // console.log(textSplit[lineNumber], textSplitEndIndex);

      const textLineTrim = textLine.trim();

      // 不检查：注释变量、变量颜色
      let isContinue = false;
      const realLineNumber = lineNumber + styleLinenumber;
      // console.log(textLineTrim, realLineNumber);

      // 如果发现是变量或者注释，直接continue
      for (const passSymbol of ["@", "--", "$", "//"]) {
        if (textLineTrim.indexOf(passSymbol) > -1) {
          isContinue = true;
          break;
        }
      }
      if (isContinue) {
        continue;
      }
      // console.log(isContinue, textLineTrim, realLineNumber);

      // 如果发现是less类型式申明的颜色值，直接continue
      for (const ojectVariableKey of Object.keys(objectVariableLineNumber)) {
        const ojectVariableValue = objectVariableLineNumber[ojectVariableKey];
        if (
          ojectVariableValue.start < realLineNumber &&
          realLineNumber < ojectVariableValue.end
        ) {
          isContinue = true;
        }
      }
      if (isContinue) {
        continue;
      }

      // 如果发现不是颜色值，直接continue
      let [colorKey, colorValue] = textLineTrim.split(":");
      if (!colorValue) {
        continue;
      }
      const filterSymbolArr = ["#", "rgba", "hsla"];
      let filterCount = 0;
      for (const filterSymbol of filterSymbolArr) {
        colorValue = colorValue.trim();
        if (colorValue.indexOf(filterSymbol) === -1) {
          filterCount += 1;
        }
      }

      if (filterCount === filterSymbolArr.length) {
        continue;
      }
      colorValue = colorValue.endsWith(";")
        ? colorValue.slice(0, -1)
        : colorValue;

      const normalizedColor = normalizeColorValue(colorValue);      

      // 如果颜色mapper不存在这个颜色值，直接continue
      if (normalizedColor && !variableMapper.has(normalizedColor)) {
        continue;
      }
      if (!normalizedColor) {
        return;
      }
      // 这个颜色变量值的位置公式：上一行最后文本位置，就是本行的首位
      // 上一行最后文本的位置 + 颜色值在这行的index
      const startIndex =
        textSplitEndIndexArr[textSplitEndIndexArrIndex - 2] +
        textLine.indexOf(colorValue);
      const startPos = document.positionAt(startIndex);
      const endPos = document.positionAt(startIndex + colorValue.length);
      const range = new vscode.Range(startPos, endPos);
      const payload = {
        normalizedColor,
        colorValue,
        range,
      };
      callback(payload);

      // console.log(colorKey, colorValue);
    }
  } catch (error) {
    console.log(error);
  }
}

function updateDiagnostics(document: vscode.TextDocument) {
  diagnosticCollection.clear();
  const diagnostics: vscode.Diagnostic[] = [];
  diagnosticsCore(document, ({ range, colorValue }) => {
    const diagnostic = new vscode.Diagnostic(
      range,
      `Color value ${colorValue} is already mapped to a variable.`,
      vscode.DiagnosticSeverity.Error
    );

    diagnostics.push(diagnostic);
    diagnosticCollection.set(document.uri, diagnostics);
  });
}

function autoReplaceVariables(
  document: vscode.TextDocument,
  isAutoReplace: boolean
) {
  if (!isAutoReplace) {
    return;
  }
  diagnosticsCore(document, ({ normalizedColor, range }) => {
    const variableName = Array.from(variableMapper.get(normalizedColor)!)[0]; // 取第一个变量名
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, variableName);
    vscode.workspace.applyEdit(edit);
  });
}

function getWorkbenchConfig() {
  workbenchConfig = vscode.workspace.getConfiguration("cssActionPro");
  return workbenchConfig;
}

function getConfig() {
  workbenchConfig = getWorkbenchConfig();
  variablesFilePaths = workbenchConfig.get<string[]>("variablesFiles");
  variablesDirectory = workbenchConfig.get<string>("variablesDirectory");
  rootFontSize = workbenchConfig.get<number>("rootFontSize")!;
  pxReplaceOptions = workbenchConfig.get<string[]>("pxReplaceOptions")!;
  colorReplaceOptions = workbenchConfig.get<string[]>("colorReplaceOptions")!;
}

function init(context: vscode.ExtensionContext) {
  getConfig();

  const supportedLanguages = ColorVarReplacer.documentSelectors.map(
    (item) => item.language
  );

  const isSupportbyLanguages = (document: vscode.TextDocument) => {
    if (!supportedLanguages.includes(document.languageId)) {
      return false;
    }
    return true;
  };

  context.subscriptions.forEach((s) => s.dispose());

  if (variablesDirectory || variablesFilePaths) {
    loadVariables();

    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(
        ColorVarReplacer.documentSelectors,
        new ColorVarReplacer(),
        {
          providedCodeActionKinds: ColorVarReplacer.providedCodeActionKinds,
        }
      )
    );

    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (!isSupportbyLanguages(document)) {
          return;
        }

        loadVariables();
      })
    );
  }

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      PxReplacer.documentSelectors,
      new PxReplacer(),
      {
        providedCodeActionKinds: PxReplacer.providedCodeActionKinds,
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("cssAction.pickVariable", showQuickPick)
  );

  // 初始化诊断集合
  diagnosticCollection = vscode.languages.createDiagnosticCollection(
    "variableDiagnostics"
  );
  context.subscriptions.push(diagnosticCollection);

  // 修改文件
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!isSupportbyLanguages(event.document)) {
        return;
      }

      updateDiagnostics(event.document);
    })
  );

  // 打开文件
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (!isSupportbyLanguages(document)) {
        return;
      }

      updateDiagnostics(document);
    })
  );

  // 保存文件
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!isSupportbyLanguages(document)) {
        return;
      }
      workbenchConfig = getWorkbenchConfig();
      isAutoReplace = workbenchConfig.get<boolean>("autoReplace") || false;

      if (isAutoReplace) {
        autoReplaceVariables(document, isAutoReplace);
        updateDiagnostics(document);
      } else {
        updateDiagnostics(document);
      }
    })
  );
}

export function activate(context: vscode.ExtensionContext) {
  init(context);
  vscode.workspace.onDidChangeConfiguration(() => init(context));
}

abstract class RegexReplacer implements vscode.CodeActionProvider {
  public abstract regex: RegExp;

  public static documentSelectors = [
    { language: "css" },
    { language: "scss" },
    { language: "less" },
    { language: "vue" },
    { language: "jsx" },
    { language: "tsx" },
  ];

  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.CodeAction[] | undefined {
    const [matchResult, line] = this.isMatchRegex(document, range);
    if (!matchResult) {
      return;
    }
    const lineRange = line.range;
    const originText = matchResult[0].trim();

    const originRange = new vscode.Range(
      lineRange.start.translate(0, matchResult.index),
      lineRange.start.translate(0, matchResult.index + originText.length)
    );

    const targetTexts = this.getReplaceTargets(originText);

    const fixes = targetTexts.map((targetText) =>
      this.createFix(document, originRange, targetText, originText)
    );

    if (fixes.length) {
      fixes[0].isPreferred = true;
    }

    return fixes;
  }

  public abstract getReplaceTargets(originText: string): string[];

  private isMatchRegex(
    document: vscode.TextDocument,
    range: vscode.Range
  ): [RegExpExecArray | null, vscode.TextLine] {
    const line = document.lineAt(range.start);
    const matchResult = this.regex.exec(line.text);
    return [matchResult, line];
  }

  private createFix(
    document: vscode.TextDocument,
    range: vscode.Range,
    targetText: string,
    originText: string
  ): vscode.CodeAction {
    const fix = new vscode.CodeAction(
      `Replace [ ${originText} ] with ${targetText}`,
      vscode.CodeActionKind.QuickFix
    );
    fix.edit = new vscode.WorkspaceEdit();
    fix.edit.replace(document.uri, range, targetText);
    return fix;
  }
}

/**
 * Provides code actions for converting px.
 */
class PxReplacer extends RegexReplacer {
  public regex = new RegExp("(-?\\d+(px|rem|em)\\s*)+(?![^(]*\\))", "i");

  private calcRem(originText: string): string {
    return originText
      .split(/\s+/)
      .map((item) => {
        const unit = item.replace(/\d+/, "");
        if (unit === "px") {
          const result = parseInt(item) / rootFontSize;
          const resultStr = result.toFixed(4).replace(/\.?0+$/, "");
          return `${resultStr}rem`;
        } else {
          return item;
        }
      })
      .join(" ");
  }

  public getReplaceTargets(originText: string): string[] {
    const normalizedOrigin = normalizeSizeValue(originText) || "";

    const varNames = variableMapper.get(normalizedOrigin) || new Set();
    const context = {
      [BultinTemplateVar.matchedText]: originText,
      [BultinTemplateVar.remResult]: this.calcRem(normalizedOrigin),
    };
    return renderOptions(pxReplaceOptions, varNames, context);
  }
}

/**
 * Provides code actions for converting hex color string to a color var.
 */

const colorRegexParts = [
  "(#[0-9a-f]{3,8}\\b)",
  "(rgb|hsl)a?[^)]*\\)",
  `(\\b(${Object.keys(tinycolor.names).join("|")})\\b)`,
];

const colorRegex = new RegExp(colorRegexParts.join("|"), "i");

class ColorVarReplacer extends RegexReplacer {
  public regex = colorRegex;

  public getReplaceTargets(originText: string): string[] {
    const colorStr = normalizeColorValue(originText) as string;
    const varNames = variableMapper.get(colorStr) || new Set();
    const context = {
      [BultinTemplateVar.matchedText]: originText,
    };

    return renderOptions(colorReplaceOptions, varNames, context);
  }
}
