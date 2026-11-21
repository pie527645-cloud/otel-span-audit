import * as path from 'node:path';
import ts from 'typescript';

const OTEL_API_SPECIFIER = '@opentelemetry/api';

const FLUENT_SPAN_METHODS = new Set<string>([
  'setAttribute',
  'setAttributes',
  'addEvent',
  'addLink',
  'addLinks',
  'setStatus',
  'updateName',
  'recordException',
]);

export function parseSourceFile(filePath: string, content: string): ts.SourceFile {
  const lower = filePath.toLowerCase();
  let scriptKind = ts.ScriptKind.TS;
  if (lower.endsWith('.tsx')) {
    scriptKind = ts.ScriptKind.TSX;
  } else if (lower.endsWith('.jsx')) {
    scriptKind = ts.ScriptKind.JSX;
  } else if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    scriptKind = ts.ScriptKind.JS;
  }
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);
}

export function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (true) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

export function unwrapFluentSpanReceiver(expr: ts.Expression): ts.Expression {
  let current = unwrapExpression(expr);
  while (ts.isCallExpression(current)) {
    const callee = unwrapExpression(current.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      FLUENT_SPAN_METHODS.has(callee.name.text)
    ) {
      current = unwrapExpression(callee.expression);
      continue;
    }
    break;
  }
  return current;
}

function isScopeBoundaryNode(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isCaseBlock(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

function isFunctionOrSourceScopeNode(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function findEnclosingScope(node: ts.Node, hoistToFunction: boolean): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (hoistToFunction) {
      if (isFunctionOrSourceScopeNode(current)) {
        return current;
      }
    } else if (isScopeBoundaryNode(current)) {
      return current;
    }
    current = current.parent;
  }
  return node;
}

export function findEnclosingFunctionOrSource(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionOrSourceScopeNode(current)) {
      return current;
    }
    current = current.parent;
  }
  return node;
}

export function findEnclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function bindPatternIdentifiers(
  nameNode: ts.BindingName,
  scopeMap: Map<string, ts.Node>
): void {
  if (ts.isIdentifier(nameNode)) {
    scopeMap.set(nameNode.text, nameNode.parent);
    return;
  }
  if (ts.isObjectBindingPattern(nameNode)) {
    for (const elem of nameNode.elements) {
      bindPatternIdentifiers(elem.name, scopeMap);
    }
  } else if (ts.isArrayBindingPattern(nameNode)) {
    for (const elem of nameNode.elements) {
      if (ts.isBindingElement(elem)) {
        bindPatternIdentifiers(elem.name, scopeMap);
      }
    }
  }
}

function isDeclarationNameIdentifier(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) {
    return false;
  }
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === id
  ) {
    return true;
  }
  if (ts.isImportSpecifier(parent)) {
    return true;
  }
  if (ts.isExportSpecifier(parent) && parent.propertyName !== undefined && parent.name === id) {
    return true;
  }
  if (ts.isBindingElement(parent)) {
    if (parent.name === id || parent.propertyName === id) {
      return true;
    }
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
    return true;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === id) {
    return true;
  }
  if (ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) {
    return true;
  }
  if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) {
    return true;
  }
  if (
    ts.isTypeReferenceNode(parent) ||
    ts.isQualifiedName(parent) ||
    ts.isTypeParameterDeclaration(parent)
  ) {
    return true;
  }
  return false;
}

export interface CrossFileOtelExports {
  readonly exportedTracers: ReadonlySet<string>;
  readonly exportedTracerFactories: ReadonlySet<string>;
  readonly defaultIsTracer: boolean;
  readonly defaultIsTracerFactory: boolean;
}

export type CrossFileExportMap = ReadonlyMap<string, CrossFileOtelExports>;

export function isOtelRequireCall(expr: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expr);
  if (!ts.isCallExpression(unwrapped) || unwrapped.arguments.length !== 1) {
    return false;
  }
  const callee = unwrapExpression(unwrapped.expression);
  if (!ts.isIdentifier(callee) || callee.text !== 'require') {
    return false;
  }
  const arg0 = unwrapped.arguments[0];
  return arg0 !== undefined && ts.isStringLiteralLike(arg0) && arg0.text === OTEL_API_SPECIFIER;
}

export function detectOtelApiImport(sourceFile: ts.SourceFile): boolean {
  let found = false;

  function visit(node: ts.Node): void {
    if (found) {
      return;
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === OTEL_API_SPECIFIER
    ) {
      found = true;
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression) &&
      node.moduleReference.expression.text === OTEL_API_SPECIFIER
    ) {
      found = true;
      return;
    }
    if (ts.isExpression(node) && isOtelRequireCall(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

export function normalizeModuleLookupKey(filePath: string): string {
  const resolved = path.resolve(filePath).replaceAll('\\', '/');
  const ext = path.posix.extname(resolved);
  const withoutExt = ext ? resolved.slice(0, resolved.length - ext.length) : resolved;
  return process.platform === 'win32' || process.platform === 'darwin'
    ? withoutExt.toLowerCase()
    : withoutExt;
}

function resolveRelativeImportKey(fromFilePath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return undefined;
  }
  const baseDir = path.dirname(path.resolve(fromFilePath));
  const target = path.resolve(baseDir, specifier);
  return normalizeModuleLookupKey(target);
}

export type StatusCodeClassification = 'ERROR' | 'NON_ERROR' | 'DYNAMIC';

export class OtelFileContext {
  public readonly sourceFile: ts.SourceFile;
  public readonly filePath: string;
  public readonly hasOtelImport: boolean;

  private readonly scopeTables = new Map<ts.Node, Map<string, ts.Node>>();
  private readonly resolvedIdentMap = new Map<ts.Identifier, ts.Node>();
  private readonly referencesByDecl = new Map<ts.Node, ts.Identifier[]>();

  public readonly otelNamespaceDecls = new Set<ts.Node>();
  public readonly traceObjectDecls = new Set<ts.Node>();
  public readonly contextObjectDecls = new Set<ts.Node>();
  public readonly spanStatusCodeDecls = new Set<ts.Node>();
  public readonly tracerTypeNames = new Set<string>();
  public readonly spanTypeNames = new Set<string>();

  public readonly tracerFactoryDecls = new Set<ts.Node>();
  public readonly classTracerMethods = new Map<ts.ClassLikeDeclaration, Set<string>>();
  public readonly tracerDecls = new Set<ts.Node>();
  public readonly classTracerFields = new Map<ts.ClassLikeDeclaration, Set<string>>();

  public readonly spanFactoryDecls = new Set<ts.Node>();
  public readonly spanDecls = new Set<ts.Node>();
  public readonly classSpanFields = new Map<ts.ClassLikeDeclaration, Set<string>>();

  constructor(
    sourceFile: ts.SourceFile,
    filePath: string,
    crossFileExports?: CrossFileExportMap
  ) {
    this.sourceFile = sourceFile;
    this.filePath = filePath;
    this.hasOtelImport = detectOtelApiImport(sourceFile);

    if (!this.hasOtelImport) {
      return;
    }

    this.buildLexicalScopes();
    this.collectReferences();
    this.seedDirectOtelImports(crossFileExports);
    this.propagateDerivedOtelBindings();
  }

  private getOrCreateScopeMap(scopeNode: ts.Node): Map<string, ts.Node> {
    let existing = this.scopeTables.get(scopeNode);
    if (!existing) {
      existing = new Map<string, ts.Node>();
      this.scopeTables.set(scopeNode, existing);
    }
    return existing;
  }

  private buildLexicalScopes(): void {
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && node.importClause) {
        const topMap = this.getOrCreateScopeMap(this.sourceFile);
        const clause = node.importClause;
        if (clause.name) {
          topMap.set(clause.name.text, clause);
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            topMap.set(clause.namedBindings.name.text, clause.namedBindings);
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const spec of clause.namedBindings.elements) {
              topMap.set(spec.name.text, spec);
            }
          }
        }
      } else if (ts.isImportEqualsDeclaration(node)) {
        const topMap = this.getOrCreateScopeMap(this.sourceFile);
        topMap.set(node.name.text, node);
      } else if (ts.isVariableDeclarationList(node)) {
        const isBlockScoped =
          (node.flags & ts.NodeFlags.Let) !== 0 || (node.flags & ts.NodeFlags.Const) !== 0;
        const targetScope = findEnclosingScope(node, !isBlockScoped);
        const map = this.getOrCreateScopeMap(targetScope);
        for (const decl of node.declarations) {
          bindPatternIdentifiers(decl.name, map);
        }
      } else if (ts.isClassDeclaration(node) && node.name) {
        const outerScope = findEnclosingScope(node, false);
        this.getOrCreateScopeMap(outerScope).set(node.name.text, node);
      } else if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
      ) {
        const fnMap = this.getOrCreateScopeMap(node);
        if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.name) {
          if (ts.isFunctionDeclaration(node)) {
            const outerScope = findEnclosingScope(node, true);
            this.getOrCreateScopeMap(outerScope).set(node.name.text, node);
          } else {
            fnMap.set(node.name.text, node);
          }
        }
        for (const param of node.parameters) {
          bindPatternIdentifiers(param.name, fnMap);
        }
      } else if (ts.isCatchClause(node) && node.variableDeclaration) {
        const catchMap = this.getOrCreateScopeMap(node);
        bindPatternIdentifiers(node.variableDeclaration.name, catchMap);
      }

      ts.forEachChild(node, visit);
    };

    visit(this.sourceFile);
  }

  private collectReferences(): void {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !isDeclarationNameIdentifier(node)) {
        const decl = this.lookupInScopes(node);
        if (decl) {
          this.resolvedIdentMap.set(node, decl);
          let list = this.referencesByDecl.get(decl);
          if (!list) {
            list = [];
            this.referencesByDecl.set(decl, list);
          }
          list.push(node);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(this.sourceFile);
  }

  private lookupInScopes(id: ts.Identifier): ts.Node | undefined {
    let current: ts.Node | undefined = id.parent;
    while (current) {
      const table = this.scopeTables.get(current);
      const hit = table?.get(id.text);
      if (hit) {
        return hit;
      }
      current = current.parent;
    }
    return undefined;
  }

  public resolveIdentifier(id: ts.Identifier): ts.Node | undefined {
    return this.resolvedIdentMap.get(id) ?? this.lookupInScopes(id);
  }

  public getReferences(decl: ts.Node): readonly ts.Identifier[] {
    return this.referencesByDecl.get(decl) ?? [];
  }

  private seedDirectOtelImports(crossFileExports?: CrossFileExportMap): void {
    for (const stmt of this.sourceFile.statements) {
      if (
        ts.isImportDeclaration(stmt) &&
        ts.isStringLiteralLike(stmt.moduleSpecifier)
      ) {
        const specText = stmt.moduleSpecifier.text;
        if (specText === OTEL_API_SPECIFIER && stmt.importClause) {
          const clause = stmt.importClause;
          if (clause.name) {
            this.otelNamespaceDecls.add(clause);
          }
          if (clause.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) {
              this.otelNamespaceDecls.add(clause.namedBindings);
            } else if (ts.isNamedImports(clause.namedBindings)) {
              for (const elem of clause.namedBindings.elements) {
                const importedName = elem.propertyName ? elem.propertyName.text : elem.name.text;
                if (importedName === 'trace') {
                  this.traceObjectDecls.add(elem);
                } else if (importedName === 'context') {
                  this.contextObjectDecls.add(elem);
                } else if (importedName === 'SpanStatusCode') {
                  this.spanStatusCodeDecls.add(elem);
                } else if (importedName === 'Tracer') {
                  this.tracerTypeNames.add(elem.name.text);
                } else if (importedName === 'Span') {
                  this.spanTypeNames.add(elem.name.text);
                }
              }
            }
          }
        } else if (crossFileExports && stmt.importClause) {
          const relKey = resolveRelativeImportKey(this.filePath, specText);
          const sibling = relKey ? crossFileExports.get(relKey) : undefined;
          if (sibling) {
            const clause = stmt.importClause;
            if (clause.name) {
              if (sibling.defaultIsTracer) {
                this.tracerDecls.add(clause);
              } else if (sibling.defaultIsTracerFactory) {
                this.tracerFactoryDecls.add(clause);
              }
            }
            if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
              for (const elem of clause.namedBindings.elements) {
                const exportedName = elem.propertyName ? elem.propertyName.text : elem.name.text;
                if (sibling.exportedTracers.has(exportedName)) {
                  this.tracerDecls.add(elem);
                } else if (sibling.exportedTracerFactories.has(exportedName)) {
                  this.tracerFactoryDecls.add(elem);
                }
              }
            }
          }
        }
      } else if (
        ts.isImportEqualsDeclaration(stmt) &&
        ts.isExternalModuleReference(stmt.moduleReference) &&
        ts.isStringLiteralLike(stmt.moduleReference.expression) &&
        stmt.moduleReference.expression.text === OTEL_API_SPECIFIER
      ) {
        this.otelNamespaceDecls.add(stmt);
      }
    }

    const visitCommonJsAndAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = unwrapExpression(node.initializer);
        if (isOtelRequireCall(init)) {
          if (ts.isIdentifier(node.name)) {
            this.otelNamespaceDecls.add(node);
          } else if (ts.isObjectBindingPattern(node.name)) {
            this.bindOtelDestructuring(node.name);
          }
        } else if (this.isOtelNamespaceExpr(init)) {
          if (ts.isIdentifier(node.name)) {
            this.otelNamespaceDecls.add(node);
          } else if (ts.isObjectBindingPattern(node.name)) {
            this.bindOtelDestructuring(node.name);
          }
        } else if (ts.isPropertyAccessExpression(init)) {
          if (
            this.isOtelNamespaceExpr(init.expression) ||
            isOtelRequireCall(init.expression)
          ) {
            if (ts.isIdentifier(node.name)) {
              if (init.name.text === 'trace') {
                this.traceObjectDecls.add(node);
              } else if (init.name.text === 'context') {
                this.contextObjectDecls.add(node);
              } else if (init.name.text === 'SpanStatusCode') {
                this.spanStatusCodeDecls.add(node);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visitCommonJsAndAliases);
    };

    visitCommonJsAndAliases(this.sourceFile);
  }

  private bindOtelDestructuring(pattern: ts.ObjectBindingPattern): void {
    for (const elem of pattern.elements) {
      if (!ts.isIdentifier(elem.name)) {
        continue;
      }
      const propName = elem.propertyName
        ? ts.isIdentifier(elem.propertyName)
          ? elem.propertyName.text
          : undefined
        : elem.name.text;
      if (propName === 'trace') {
        this.traceObjectDecls.add(elem);
      } else if (propName === 'context') {
        this.contextObjectDecls.add(elem);
      } else if (propName === 'SpanStatusCode') {
        this.spanStatusCodeDecls.add(elem);
      }
    }
  }

  public isOtelNamespaceExpr(expr: ts.Expression): boolean {
    const unwrapped = unwrapExpression(expr);
    if (!ts.isIdentifier(unwrapped)) {
      return false;
    }
    const decl = this.resolveIdentifier(unwrapped);
    return decl !== undefined && this.otelNamespaceDecls.has(decl);
  }

  public isTraceObjectExpr(expr: ts.Expression): boolean {
    const unwrapped = unwrapExpression(expr);
    if (ts.isIdentifier(unwrapped)) {
      const decl = this.resolveIdentifier(unwrapped);
      return decl !== undefined && this.traceObjectDecls.has(decl);
    }
    if (ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === 'trace') {
      return (
        this.isOtelNamespaceExpr(unwrapped.expression) ||
        isOtelRequireCall(unwrapped.expression)
      );
    }
    return false;
  }

  public isContextObjectExpr(expr: ts.Expression): boolean {
    const unwrapped = unwrapExpression(expr);
    if (ts.isIdentifier(unwrapped)) {
      const decl = this.resolveIdentifier(unwrapped);
      return decl !== undefined && this.contextObjectDecls.has(decl);
    }
    if (ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === 'context') {
      return (
        this.isOtelNamespaceExpr(unwrapped.expression) ||
        isOtelRequireCall(unwrapped.expression)
      );
    }
    return false;
  }

  public isSpanStatusCodeObjectExpr(expr: ts.Expression): boolean {
    const unwrapped = unwrapExpression(expr);
    if (ts.isIdentifier(unwrapped)) {
      const decl = this.resolveIdentifier(unwrapped);
      return decl !== undefined && this.spanStatusCodeDecls.has(decl);
    }
    if (ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === 'SpanStatusCode') {
      return (
        this.isOtelNamespaceExpr(unwrapped.expression) ||
        isOtelRequireCall(unwrapped.expression)
      );
    }
    return false;
  }

  public isOtelTypeNode(typeNode: ts.TypeNode | undefined, kind: 'Tracer' | 'Span'): boolean {
    if (!typeNode) {
      return false;
    }
    if (ts.isParenthesizedTypeNode(typeNode)) {
      return this.isOtelTypeNode(typeNode.type, kind);
    }
    if (ts.isUnionTypeNode(typeNode)) {
      return typeNode.types.some((member) => this.isOtelTypeNode(member, kind));
    }
    if (!ts.isTypeReferenceNode(typeNode)) {
      return false;
    }
    const typeName = typeNode.typeName;
    if (ts.isIdentifier(typeName)) {
      return kind === 'Tracer'
        ? this.tracerTypeNames.has(typeName.text)
        : this.spanTypeNames.has(typeName.text);
    }
    if (ts.isQualifiedName(typeName) && ts.isIdentifier(typeName.left)) {
      const nsDecl = this.resolveIdentifier(typeName.left);
      return (
        nsDecl !== undefined &&
        this.otelNamespaceDecls.has(nsDecl) &&
        typeName.right.text === kind
      );
    }
    return false;
  }

  public isDirectGetTracerCall(expr: ts.Expression): boolean {
    const unwrapped = unwrapExpression(expr);
    if (!ts.isCallExpression(unwrapped)) {
      return false;
    }
    const callee = unwrapExpression(unwrapped.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'getTracer') {
      return false;
    }
    const receiver = unwrapExpression(callee.expression);
    if (this.isTraceObjectExpr(receiver)) {
      return true;
    }
    if (ts.isCallExpression(receiver)) {
      const providerCallee = unwrapExpression(receiver.expression);
      if (
        ts.isPropertyAccessExpression(providerCallee) &&
        providerCallee.name.text === 'getTracerProvider' &&
        this.isTraceObjectExpr(providerCallee.expression)
      ) {
        return true;
      }
    }
    return false;
  }

  public isTracerExpr(expr: ts.Expression): boolean {
    const unwrapped = unwrapExpression(expr);
    if (this.isDirectGetTracerCall(unwrapped)) {
      return true;
    }
    if (ts.isIdentifier(unwrapped)) {
      const decl = this.resolveIdentifier(unwrapped);
      return decl !== undefined && this.tracerDecls.has(decl);
    }
    if (
      ts.isPropertyAccessExpression(unwrapped) &&
      unwrapped.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const cls = findEnclosingClass(unwrapped);
      return cls !== undefined && (this.classTracerFields.get(cls)?.has(unwrapped.name.text) ?? false);
    }
    if (ts.isCallExpression(unwrapped)) {
      const callee = unwrapExpression(unwrapped.expression);
      if (ts.isIdentifier(callee)) {
        const decl = this.resolveIdentifier(callee);
        return decl !== undefined && this.tracerFactoryDecls.has(decl);
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const cls = findEnclosingClass(callee);
        return cls !== undefined && (this.classTracerMethods.get(cls)?.has(callee.name.text) ?? false);
      }
    }
    if (ts.isBinaryExpression(unwrapped)) {
      const op = unwrapped.operatorToken.kind;
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.EqualsToken
      ) {
        return this.isTracerExpr(unwrapped.left) || this.isTracerExpr(unwrapped.right);
      }
    }
    return false;
  }

  public isActiveSpanBorrowCall(expr: ts.Expression): boolean {
    const unwrapped = unwrapExpression(expr);
    if (!ts.isCallExpression(unwrapped)) {
      return false;
    }
    const callee = unwrapExpression(unwrapped.expression);
    if (!ts.isPropertyAccessExpression(callee)) {
      return false;
    }
    const methodName = callee.name.text;
    if (methodName !== 'getActiveSpan' && methodName !== 'getSpan') {
      return false;
    }
    return this.isTraceObjectExpr(callee.expression);
  }

  public extractStartSpanCall(expr: ts.Expression): ts.CallExpression | undefined {
    const root = unwrapFluentSpanReceiver(expr);
    if (!ts.isCallExpression(root)) {
      return undefined;
    }
    const callee = unwrapExpression(root.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'startSpan') {
      return undefined;
    }
    return this.isTracerExpr(callee.expression) ? root : undefined;
  }

  public isStartActiveSpanCall(call: ts.CallExpression): boolean {
    const callee = unwrapExpression(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'startActiveSpan') {
      return false;
    }
    return this.isTracerExpr(callee.expression);
  }

  public isTraceSetSpanCall(call: ts.CallExpression): boolean {
    const callee = unwrapExpression(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'setSpan') {
      return false;
    }
    return this.isTraceObjectExpr(callee.expression);
  }

  public isContextWithCall(call: ts.CallExpression): boolean {
    const callee = unwrapExpression(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'with') {
      return false;
    }
    return this.isContextObjectExpr(callee.expression);
  }

  public isSpanExpr(expr: ts.Expression): boolean {
    const unwrapped = unwrapFluentSpanReceiver(expr);
    if (this.extractStartSpanCall(unwrapped) !== undefined) {
      return true;
    }
    if (this.isActiveSpanBorrowCall(unwrapped)) {
      return true;
    }
    if (ts.isIdentifier(unwrapped)) {
      const decl = this.resolveIdentifier(unwrapped);
      return decl !== undefined && this.spanDecls.has(decl);
    }
    if (
      ts.isPropertyAccessExpression(unwrapped) &&
      unwrapped.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const cls = findEnclosingClass(unwrapped);
      return cls !== undefined && (this.classSpanFields.get(cls)?.has(unwrapped.name.text) ?? false);
    }
    if (ts.isCallExpression(unwrapped)) {
      const callee = unwrapExpression(unwrapped.expression);
      if (ts.isIdentifier(callee)) {
        const decl = this.resolveIdentifier(callee);
        return decl !== undefined && this.spanFactoryDecls.has(decl);
      }
    }
    if (ts.isBinaryExpression(unwrapped)) {
      const op = unwrapped.operatorToken.kind;
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.EqualsToken
      ) {
        return this.isSpanExpr(unwrapped.left) || this.isSpanExpr(unwrapped.right);
      }
    }
    return false;
  }

  private functionReturnsExprMatching(
    fn: ts.FunctionLikeDeclarationBase,
    predicate: (expr: ts.Expression) => boolean
  ): boolean {
    if (!fn.body) {
      return false;
    }
    if (!ts.isBlock(fn.body)) {
      return predicate(fn.body);
    }
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) {
        return;
      }
      if (node !== fn.body && isFunctionOrSourceScopeNode(node)) {
        return;
      }
      if (ts.isReturnStatement(node) && node.expression && predicate(node.expression)) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return found;
  }

  private addClassField(
    map: Map<ts.ClassLikeDeclaration, Set<string>>,
    cls: ts.ClassLikeDeclaration,
    fieldName: string
  ): void {
    let set = map.get(cls);
    if (!set) {
      set = new Set<string>();
      map.set(cls, set);
    }
    set.add(fieldName);
  }

  private propagateDerivedOtelBindings(): void {
    for (let pass = 0; pass < 3; pass += 1) {
      const visitTracers = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node)) {
          if (
            this.isOtelTypeNode(node.type, 'Tracer') ||
            this.functionReturnsExprMatching(node, (e) => this.isTracerExpr(e))
          ) {
            this.tracerFactoryDecls.add(node);
          }
        } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
          const cls = findEnclosingClass(node);
          if (
            cls &&
            (this.isOtelTypeNode(node.type, 'Tracer') ||
              this.functionReturnsExprMatching(node, (e) => this.isTracerExpr(e)))
          ) {
            this.addClassField(this.classTracerMethods, cls, node.name.text);
          }
        } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          if (this.isOtelTypeNode(node.type, 'Tracer')) {
            this.tracerDecls.add(node);
          } else if (node.initializer) {
            const init = unwrapExpression(node.initializer);
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
              if (
                this.isOtelTypeNode(init.type, 'Tracer') ||
                this.functionReturnsExprMatching(init, (e) => this.isTracerExpr(e))
              ) {
                this.tracerFactoryDecls.add(node);
              }
            } else if (this.isTracerExpr(init)) {
              this.tracerDecls.add(node);
            }
          }
        } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
          if (
            this.isOtelTypeNode(node.type, 'Tracer') ||
            (node.initializer !== undefined && this.isTracerExpr(node.initializer))
          ) {
            this.tracerDecls.add(node);
            if (
              ts.isConstructorDeclaration(node.parent) &&
              ts.canHaveModifiers(node) &&
              ts.getModifiers(node)?.some(
                (m) =>
                  m.kind === ts.SyntaxKind.PrivateKeyword ||
                  m.kind === ts.SyntaxKind.ProtectedKeyword ||
                  m.kind === ts.SyntaxKind.PublicKeyword ||
                  m.kind === ts.SyntaxKind.ReadonlyKeyword
              )
            ) {
              const cls = findEnclosingClass(node.parent);
              if (cls) {
                this.addClassField(this.classTracerFields, cls, node.name.text);
              }
            }
          }
        } else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
          const cls = findEnclosingClass(node);
          if (
            cls &&
            (this.isOtelTypeNode(node.type, 'Tracer') ||
              (node.initializer !== undefined && this.isTracerExpr(node.initializer)))
          ) {
            this.addClassField(this.classTracerFields, cls, node.name.text);
          }
        } else if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          this.isTracerExpr(node.right)
        ) {
          const lhs = unwrapExpression(node.left);
          if (ts.isIdentifier(lhs)) {
            const decl = this.resolveIdentifier(lhs);
            if (decl) {
              this.tracerDecls.add(decl);
            }
          } else if (
            ts.isPropertyAccessExpression(lhs) &&
            lhs.expression.kind === ts.SyntaxKind.ThisKeyword
          ) {
            const cls = findEnclosingClass(lhs);
            if (cls) {
              this.addClassField(this.classTracerFields, cls, lhs.name.text);
            }
          }
        }

        ts.forEachChild(node, visitTracers);
      };

      visitTracers(this.sourceFile);
    }

    for (let pass = 0; pass < 2; pass += 1) {
      const visitSpans = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node)) {
          if (
            this.isOtelTypeNode(node.type, 'Span') ||
            this.functionReturnsExprMatching(node, (e) => this.isSpanExpr(e))
          ) {
            this.spanFactoryDecls.add(node);
          }
        } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          if (this.isOtelTypeNode(node.type, 'Span')) {
            this.spanDecls.add(node);
          } else if (node.initializer) {
            const init = unwrapExpression(node.initializer);
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
              if (
                this.isOtelTypeNode(init.type, 'Span') ||
                this.functionReturnsExprMatching(init, (e) => this.isSpanExpr(e))
              ) {
                this.spanFactoryDecls.add(node);
              }
            } else if (this.isSpanExpr(init)) {
              this.spanDecls.add(node);
            }
          }
        } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
          if (
            this.isOtelTypeNode(node.type, 'Span') ||
            (node.initializer !== undefined && this.isSpanExpr(node.initializer))
          ) {
            this.spanDecls.add(node);
            if (
              ts.isConstructorDeclaration(node.parent) &&
              ts.canHaveModifiers(node) &&
              ts.getModifiers(node)?.some(
                (m) =>
                  m.kind === ts.SyntaxKind.PrivateKeyword ||
                  m.kind === ts.SyntaxKind.ProtectedKeyword ||
                  m.kind === ts.SyntaxKind.PublicKeyword ||
                  m.kind === ts.SyntaxKind.ReadonlyKeyword
              )
            ) {
              const cls = findEnclosingClass(node.parent);
              if (cls) {
                this.addClassField(this.classSpanFields, cls, node.name.text);
              }
            }
          }
        } else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
          const cls = findEnclosingClass(node);
          if (
            cls &&
            (this.isOtelTypeNode(node.type, 'Span') ||
              (node.initializer !== undefined && this.isSpanExpr(node.initializer)))
          ) {
            this.addClassField(this.classSpanFields, cls, node.name.text);
          }
        } else if (ts.isCallExpression(node) && this.isStartActiveSpanCall(node)) {
          if (node.arguments.length >= 2) {
            const lastArg = unwrapExpression(node.arguments[node.arguments.length - 1]);
            if (
              (ts.isArrowFunction(lastArg) || ts.isFunctionExpression(lastArg)) &&
              lastArg.parameters.length >= 1
            ) {
              const firstParam = lastArg.parameters[0];
              if (firstParam && ts.isIdentifier(firstParam.name)) {
                this.spanDecls.add(firstParam);
              }
            }
          }
        } else if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          this.isSpanExpr(node.right)
        ) {
          const lhs = unwrapExpression(node.left);
          if (ts.isIdentifier(lhs)) {
            const decl = this.resolveIdentifier(lhs);
            if (decl) {
              this.spanDecls.add(decl);
            }
          } else if (
            ts.isPropertyAccessExpression(lhs) &&
            lhs.expression.kind === ts.SyntaxKind.ThisKeyword
          ) {
            const cls = findEnclosingClass(lhs);
            if (cls) {
              this.addClassField(this.classSpanFields, cls, lhs.name.text);
            }
          }
        }

        ts.forEachChild(node, visitSpans);
      };

      visitSpans(this.sourceFile);
    }
  }

  public collectModuleExports(): CrossFileOtelExports {
    const exportedTracers = new Set<string>();
    const exportedTracerFactories = new Set<string>();
    let defaultIsTracer = false;
    let defaultIsTracerFactory = false;

    const hasExportModifier = (node: ts.Node): boolean =>
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);

    const hasDefaultModifier = (node: ts.Node): boolean =>
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false);

    for (const stmt of this.sourceFile.statements) {
      if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            if (this.tracerDecls.has(decl)) {
              exportedTracers.add(decl.name.text);
            } else if (this.tracerFactoryDecls.has(decl)) {
              exportedTracerFactories.add(decl.name.text);
            }
          }
        }
      } else if (ts.isFunctionDeclaration(stmt) && hasExportModifier(stmt)) {
        if (this.tracerFactoryDecls.has(stmt)) {
          if (hasDefaultModifier(stmt)) {
            defaultIsTracerFactory = true;
          }
          if (stmt.name) {
            exportedTracerFactories.add(stmt.name.text);
          }
        }
      } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        const expr = unwrapExpression(stmt.expression);
        if (this.isTracerExpr(expr)) {
          defaultIsTracer = true;
        } else if (ts.isIdentifier(expr)) {
          const decl = this.resolveIdentifier(expr);
          if (decl && this.tracerFactoryDecls.has(decl)) {
            defaultIsTracerFactory = true;
          }
        }
      } else if (
        ts.isExportDeclaration(stmt) &&
        !stmt.moduleSpecifier &&
        stmt.exportClause &&
        ts.isNamedExports(stmt.exportClause)
      ) {
        for (const spec of stmt.exportClause.elements) {
          const localIdent = spec.propertyName ?? spec.name;
          if (!ts.isIdentifier(localIdent)) {
            continue;
          }
          const decl = this.resolveIdentifier(localIdent);
          if (decl) {
            if (this.tracerDecls.has(decl)) {
              exportedTracers.add(spec.name.text);
            } else if (this.tracerFactoryDecls.has(decl)) {
              exportedTracerFactories.add(spec.name.text);
            }
          }
        }
      }
    }

    return {
      exportedTracers,
      exportedTracerFactories,
      defaultIsTracer,
      defaultIsTracerFactory,
    };
  }

  public classifyStatusCodeExpr(
    expr: ts.Expression,
    visitedDecls = new Set<ts.Node>()
  ): StatusCodeClassification {
    const unwrapped = unwrapExpression(expr);

    if (ts.isNumericLiteral(unwrapped)) {
      if (unwrapped.text === '2') {
        return 'ERROR';
      }
      if (unwrapped.text === '0' || unwrapped.text === '1') {
        return 'NON_ERROR';
      }
      return 'DYNAMIC';
    }

    if (ts.isPropertyAccessExpression(unwrapped)) {
      if (this.isSpanStatusCodeObjectExpr(unwrapped.expression)) {
        if (unwrapped.name.text === 'ERROR') {
          return 'ERROR';
        }
        if (unwrapped.name.text === 'OK' || unwrapped.name.text === 'UNSET') {
          return 'NON_ERROR';
        }
      }
      return 'DYNAMIC';
    }

    if (ts.isIdentifier(unwrapped)) {
      const decl = this.resolveIdentifier(unwrapped);
      if (
        decl &&
        !visitedDecls.has(decl) &&
        ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        ts.isVariableDeclarationList(decl.parent) &&
        (decl.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        visitedDecls.add(decl);
        return this.classifyStatusCodeExpr(decl.initializer, visitedDecls);
      }
      return 'DYNAMIC';
    }

    return 'DYNAMIC';
  }
}
