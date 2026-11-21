import ts from 'typescript';
import {
  type CrossFileExportMap,
  type CrossFileOtelExports,
  findEnclosingClass,
  findEnclosingFunctionOrSource,
  normalizeModuleLookupKey,
  OtelFileContext,
  parseSourceFile,
  unwrapExpression,
  unwrapFluentSpanReceiver,
} from './otelTracking.js';
import { RULE_MAP } from './rules.js';
import type { Finding, RuleId, SourceInput } from './types.js';

export interface AnalyzerOptions {
  readonly includeTests?: boolean;
}

interface PathOutcome {
  readonly fallsThroughUnended: boolean;
  readonly returnsUnended: boolean;
  readonly throwsUnended: boolean;
}

const ENDED_CLEAN: PathOutcome = {
  fallsThroughUnended: false,
  returnsUnended: false,
  throwsUnended: false,
};

const STILL_UNENDED: PathOutcome = {
  fallsThroughUnended: true,
  returnsUnended: false,
  throwsUnended: false,
};

function isCleanOutcome(outcome: PathOutcome): boolean {
  return (
    !outcome.fallsThroughUnended &&
    !outcome.returnsUnended &&
    !outcome.throwsUnended
  );
}

const FLUENT_SPAN_CHAIN_METHODS = new Set<string>([
  'setAttribute',
  'setAttributes',
  'addEvent',
  'addLink',
  'addLinks',
  'setStatus',
  'updateName',
  'recordException',
]);

function walkUpParensAndAssertions(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

function walkUpFluentSpanCalls(expr: ts.Expression): ts.Expression {
  let current = walkUpParensAndAssertions(expr);
  while (
    current.parent &&
    ts.isPropertyAccessExpression(current.parent) &&
    current.parent.expression === current &&
    FLUENT_SPAN_CHAIN_METHODS.has(current.parent.name.text) &&
    current.parent.parent &&
    ts.isCallExpression(current.parent.parent) &&
    current.parent.parent.expression === current.parent
  ) {
    current = walkUpParensAndAssertions(current.parent.parent);
  }
  return current;
}

function isImmediateChainedEndCall(chainTop: ts.Expression): boolean {
  const parent = chainTop.parent;
  return (
    parent !== undefined &&
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === chainTop &&
    parent.name.text === 'end' &&
    parent.parent !== undefined &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  );
}

function doesContextValueEscape(
  setSpanCall: ts.CallExpression,
  ctx: OtelFileContext
): boolean {
  const top = walkUpParensAndAssertions(setSpanCall);
  const parent = top.parent;
  if (!parent) {
    return false;
  }

  if (
    ts.isCallExpression(parent) &&
    ctx.isContextWithCall(parent) &&
    parent.arguments[0] !== undefined &&
    walkUpParensAndAssertions(parent.arguments[0]) === top
  ) {
    return false;
  }

  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const refs = ctx.getReferences(parent);
    for (const ref of refs) {
      const refTop = walkUpParensAndAssertions(ref);
      const refParent = refTop.parent;
      if (
        refParent &&
        ts.isCallExpression(refParent) &&
        ctx.isContextWithCall(refParent) &&
        refParent.arguments[0] !== undefined &&
        walkUpParensAndAssertions(refParent.arguments[0]) === refTop
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  return true;
}

function doesValueExpressionEscape(
  startExpr: ts.Expression,
  ctx: OtelFileContext,
  ownerScope?: ts.Node
): boolean {
  let cur: ts.Node = walkUpFluentSpanCalls(startExpr);

  while (cur.parent) {
    const parent: ts.Node = cur.parent;

    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isAwaitExpression(parent)
    ) {
      cur = parent;
      continue;
    }

    if (
      (ts.isPropertyAssignment(parent) && parent.initializer === cur) ||
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isSpreadAssignment(parent)
    ) {
      return true;
    }

    if (ts.isObjectLiteralExpression(parent) || ts.isArrayLiteralExpression(parent)) {
      return true;
    }

    if (ts.isSpreadElement(parent)) {
      return true;
    }

    if (
      ts.isConditionalExpression(parent) &&
      (parent.whenTrue === cur || parent.whenFalse === cur)
    ) {
      cur = parent;
      continue;
    }

    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if (
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        (op === ts.SyntaxKind.CommaToken && parent.right === cur)
      ) {
        cur = parent;
        continue;
      }

      if (op === ts.SyntaxKind.EqualsToken && parent.right === cur) {
        const lhs = unwrapExpression(parent.left);
        if (ts.isPropertyAccessExpression(lhs) || ts.isElementAccessExpression(lhs)) {
          return true;
        }
        if (ts.isIdentifier(lhs)) {
          const targetDecl = ctx.resolveIdentifier(lhs);
          if (!targetDecl) {
            return true;
          }
          if (
            ownerScope !== undefined &&
            findEnclosingFunctionOrSource(targetDecl) !== ownerScope
          ) {
            return true;
          }
        }
      }
      return false;
    }

    if (ts.isReturnStatement(parent)) {
      return true;
    }

    if (ts.isArrowFunction(parent) && parent.body === cur) {
      return true;
    }

    if (ts.isCallExpression(parent)) {
      const isArg = parent.arguments.some((arg) => arg === cur);
      if (isArg) {
        if (ctx.isTraceSetSpanCall(parent)) {
          return doesContextValueEscape(parent, ctx);
        }
        return true;
      }
      return false;
    }

    if (ts.isNewExpression(parent) && parent.arguments) {
      if (parent.arguments.some((arg) => arg === cur)) {
        return true;
      }
      return false;
    }

    if (ts.isPropertyDeclaration(parent) || ts.isExportAssignment(parent)) {
      return true;
    }

    return false;
  }

  return false;
}

function isExportedVariableDecl(decl: ts.Node): boolean {
  if (!ts.isVariableDeclaration(decl)) {
    return false;
  }
  const list = decl.parent;
  if (!list || !ts.isVariableDeclarationList(list)) {
    return false;
  }
  const stmt = list.parent;
  if (!stmt || !ts.isVariableStatement(stmt) || !ts.canHaveModifiers(stmt)) {
    return false;
  }
  return ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function isDeferredHandlerClosure(innerFn: ts.Node, ownerScope: ts.Node): boolean {
  if (innerFn === ownerScope) {
    return false;
  }
  if (!ts.isArrowFunction(innerFn) && !ts.isFunctionExpression(innerFn)) {
    return true;
  }
  const top = walkUpParensAndAssertions(innerFn);
  const parent = top.parent;
  if (!parent) {
    return false;
  }
  if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === top)) {
    return true;
  }
  if (ts.isCallExpression(parent) && parent.arguments.some((a) => walkUpParensAndAssertions(a) === top)) {
    const callee = unwrapExpression(parent.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const m = callee.name.text;
      if (m === 'then' || m === 'catch' || m === 'finally') {
        return false;
      }
      if (ctxIsContextWithName(callee)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function ctxIsContextWithName(callee: ts.PropertyAccessExpression): boolean {
  return callee.name.text === 'with';
}

function doesSpanBindingEscape(
  spanDecl: ts.Node,
  ownerScope: ts.Node,
  assignNodeToIgnore: ts.Node | undefined,
  ctx: OtelFileContext
): boolean {
  if (isExportedVariableDecl(spanDecl)) {
    return true;
  }

  if (findEnclosingFunctionOrSource(spanDecl) !== ownerScope) {
    return true;
  }

  const refs = ctx.getReferences(spanDecl);
  for (const ref of refs) {
    if (assignNodeToIgnore !== undefined && ref === assignNodeToIgnore) {
      continue;
    }

    if (
      ref.parent &&
      ts.isVariableDeclaration(ref.parent) &&
      ref.parent.initializer !== undefined &&
      unwrapExpression(ref.parent.initializer) === ref
    ) {
      return true;
    }

    if (
      ref.parent &&
      ts.isBinaryExpression(ref.parent) &&
      ref.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      unwrapExpression(ref.parent.right) === ref
    ) {
      const lhs = unwrapExpression(ref.parent.left);
      if (!ts.isIdentifier(lhs) || ctx.resolveIdentifier(lhs) !== spanDecl) {
        return true;
      }
    }

    if (doesValueExpressionEscape(ref, ctx, ownerScope)) {
      return true;
    }

    const enclosingFn = findEnclosingFunctionOrSource(ref);
    if (enclosingFn !== ownerScope && isDeferredHandlerClosure(enclosingFn, ownerScope)) {
      if (
        ref.parent &&
        ts.isPropertyAccessExpression(ref.parent) &&
        ref.parent.name.text === 'end'
      ) {
        return true;
      }
    }
  }

  return false;
}

function functionUsesOwnArgumentsObject(fn: ts.FunctionExpression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (
      node !== fn &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node))
    ) {
      return;
    }
    if (
      ts.isIdentifier(node) &&
      node.text === 'arguments' &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return found;
}

function isSpanEndCallOnDecl(
  expr: ts.Expression,
  spanDecl: ts.Node,
  ctx: OtelFileContext
): boolean {
  const unwrapped = unwrapExpression(expr);
  if (!ts.isCallExpression(unwrapped)) {
    return false;
  }
  const callee = unwrapExpression(unwrapped.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'end') {
    return false;
  }
  const rootRecv = unwrapFluentSpanReceiver(callee.expression);
  if (!ts.isIdentifier(rootRecv)) {
    return false;
  }
  return ctx.resolveIdentifier(rootRecv) === spanDecl;
}

function isTruthinessGuardForSpan(
  cond: ts.Expression,
  spanDecl: ts.Node,
  ctx: OtelFileContext
): boolean {
  const unwrapped = unwrapExpression(cond);
  if (ts.isIdentifier(unwrapped)) {
    return ctx.resolveIdentifier(unwrapped) === spanDecl;
  }
  if (
    ts.isPrefixUnaryExpression(unwrapped) &&
    unwrapped.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isPrefixUnaryExpression(unwrapExpression(unwrapped.operand)) &&
    (unwrapExpression(unwrapped.operand) as ts.PrefixUnaryExpression).operator ===
      ts.SyntaxKind.ExclamationToken
  ) {
    const inner = unwrapExpression(
      (unwrapExpression(unwrapped.operand) as ts.PrefixUnaryExpression).operand
    );
    return ts.isIdentifier(inner) && ctx.resolveIdentifier(inner) === spanDecl;
  }
  if (ts.isCallExpression(unwrapped) && unwrapped.arguments.length === 1) {
    const callee = unwrapExpression(unwrapped.expression);
    if (ts.isIdentifier(callee) && callee.text === 'Boolean') {
      const arg = unwrapExpression(unwrapped.arguments[0]);
      return ts.isIdentifier(arg) && ctx.resolveIdentifier(arg) === spanDecl;
    }
  }
  if (ts.isBinaryExpression(unwrapped)) {
    const op = unwrapped.operatorToken.kind;
    if (
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      const left = unwrapExpression(unwrapped.left);
      const right = unwrapExpression(unwrapped.right);
      const isNullish = (n: ts.Expression): boolean =>
        n.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(n) && n.text === 'undefined');
      if (ts.isIdentifier(left) && ctx.resolveIdentifier(left) === spanDecl && isNullish(right)) {
        return true;
      }
      if (ts.isIdentifier(right) && ctx.resolveIdentifier(right) === spanDecl && isNullish(left)) {
        return true;
      }
    }
  }
  return false;
}

function containsUnprotectedAwait(node: ts.Node): boolean {
  let found = false;
  const visit = (cur: ts.Node): void => {
    if (found) {
      return;
    }
    if (
      ts.isArrowFunction(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isFunctionDeclaration(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isClassExpression(cur)
    ) {
      return;
    }
    if (ts.isAwaitExpression(cur)) {
      found = true;
      return;
    }
    ts.forEachChild(cur, visit);
  };
  visit(node);
  return found;
}

function evalInlineFunctionBody(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  spanDecl: ts.Node,
  ctx: OtelFileContext
): PathOutcome {
  if (ts.isBlock(fn.body)) {
    return evalStatementList(fn.body.statements, 0, spanDecl, ctx);
  }
  return evalReturnExpression(fn.body, spanDecl, ctx);
}

function isPromiseChainEndingSpan(
  expr: ts.Expression,
  spanDecl: ts.Node,
  ctx: OtelFileContext,
  visitedDecls = new Set<ts.Node>()
): boolean {
  const unwrapped = unwrapExpression(expr);

  if (ts.isIdentifier(unwrapped)) {
    const decl = ctx.resolveIdentifier(unwrapped);
    if (
      decl &&
      !visitedDecls.has(decl) &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer
    ) {
      visitedDecls.add(decl);
      return isPromiseChainEndingSpan(decl.initializer, spanDecl, ctx, visitedDecls);
    }
    return false;
  }

  if (!ts.isCallExpression(unwrapped)) {
    return false;
  }
  const callee = unwrapExpression(unwrapped.expression);
  if (!ts.isPropertyAccessExpression(callee)) {
    return false;
  }

  const receiver = unwrapExpression(callee.expression);
  if (containsUnprotectedAwait(receiver)) {
    return false;
  }

  const method = callee.name.text;

  if (method === 'finally' && unwrapped.arguments.length >= 1) {
    const cb = unwrapExpression(unwrapped.arguments[0]);
    if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) {
      return isCleanOutcome(evalInlineFunctionBody(cb, spanDecl, ctx));
    }
    return false;
  }

  if (method === 'then') {
    if (unwrapped.arguments.length >= 2) {
      const onFulfilled = unwrapExpression(unwrapped.arguments[0]);
      const onRejected = unwrapExpression(unwrapped.arguments[1]);
      if (
        (ts.isArrowFunction(onFulfilled) || ts.isFunctionExpression(onFulfilled)) &&
        (ts.isArrowFunction(onRejected) || ts.isFunctionExpression(onRejected))
      ) {
        return (
          isCleanOutcome(evalInlineFunctionBody(onFulfilled, spanDecl, ctx)) &&
          isCleanOutcome(evalInlineFunctionBody(onRejected, spanDecl, ctx))
        );
      }
    }
    return isPromiseChainEndingSpan(receiver, spanDecl, ctx, visitedDecls);
  }

  if (method === 'catch' && unwrapped.arguments.length >= 1) {
    const onRejected = unwrapExpression(unwrapped.arguments[0]);
    if (
      (ts.isArrowFunction(onRejected) || ts.isFunctionExpression(onRejected)) &&
      isCleanOutcome(evalInlineFunctionBody(onRejected, spanDecl, ctx))
    ) {
      if (isPromiseChainEndingSpan(receiver, spanDecl, ctx, visitedDecls)) {
        return true;
      }
      if (ts.isCallExpression(receiver)) {
        const prevCallee = unwrapExpression(receiver.expression);
        if (
          ts.isPropertyAccessExpression(prevCallee) &&
          prevCallee.name.text === 'then' &&
          receiver.arguments.length >= 1 &&
          !containsUnprotectedAwait(prevCallee.expression)
        ) {
          const onFulfilled = unwrapExpression(receiver.arguments[0]);
          if (ts.isArrowFunction(onFulfilled) || ts.isFunctionExpression(onFulfilled)) {
            return isCleanOutcome(evalInlineFunctionBody(onFulfilled, spanDecl, ctx));
          }
        }
      }
    }
    return isPromiseChainEndingSpan(receiver, spanDecl, ctx, visitedDecls);
  }

  return false;
}

interface ExprEvalState {
  readonly ended: boolean;
  readonly throwsUnended: boolean;
  readonly returnsUnended: boolean;
  readonly overwritten: boolean;
}

function evalExprWhileUnended(
  expr: ts.Expression,
  spanDecl: ts.Node,
  ctx: OtelFileContext
): ExprEvalState {
  const unwrapped = unwrapExpression(expr);

  if (
    ts.isArrowFunction(unwrapped) ||
    ts.isFunctionExpression(unwrapped) ||
    ts.isClassExpression(unwrapped)
  ) {
    return { ended: false, throwsUnended: false, returnsUnended: false, overwritten: false };
  }

  if (ts.isCallExpression(unwrapped) && ctx.isContextWithCall(unwrapped)) {
    const lastArg =
      unwrapped.arguments.length >= 2
        ? unwrapExpression(unwrapped.arguments[unwrapped.arguments.length - 1])
        : undefined;
    if (lastArg && (ts.isArrowFunction(lastArg) || ts.isFunctionExpression(lastArg))) {
      const cbRes = evalInlineFunctionBody(lastArg, spanDecl, ctx);
      return {
        ended: !cbRes.fallsThroughUnended,
        throwsUnended: cbRes.throwsUnended,
        returnsUnended: cbRes.returnsUnended,
        overwritten: false,
      };
    }
  }

  if (isSpanEndCallOnDecl(unwrapped, spanDecl, ctx)) {
    const call = unwrapped as ts.CallExpression;
    let throwsBeforeEnd = false;
    const callee = unwrapExpression(call.expression) as ts.PropertyAccessExpression;
    const recvState = evalExprWhileUnended(callee.expression, spanDecl, ctx);
    if (recvState.throwsUnended) {
      throwsBeforeEnd = true;
    }
    for (const arg of call.arguments) {
      const argState = evalExprWhileUnended(arg, spanDecl, ctx);
      if (argState.throwsUnended) {
        throwsBeforeEnd = true;
      }
    }
    return {
      ended: true,
      throwsUnended: throwsBeforeEnd,
      returnsUnended: false,
      overwritten: false,
    };
  }

  if (ts.isAwaitExpression(unwrapped)) {
    const inner = evalExprWhileUnended(unwrapped.expression, spanDecl, ctx);
    if (inner.ended && !inner.throwsUnended && !inner.returnsUnended) {
      return inner;
    }
    return {
      ended: inner.ended,
      throwsUnended: true,
      returnsUnended: inner.returnsUnended,
      overwritten: inner.overwritten,
    };
  }

  if (ts.isConditionalExpression(unwrapped)) {
    const condState = evalExprWhileUnended(unwrapped.condition, spanDecl, ctx);
    if (condState.ended) {
      return condState;
    }
    const tState = evalExprWhileUnended(unwrapped.whenTrue, spanDecl, ctx);
    const fState = evalExprWhileUnended(unwrapped.whenFalse, spanDecl, ctx);
    return {
      ended: tState.ended && fState.ended,
      throwsUnended: condState.throwsUnended || tState.throwsUnended || fState.throwsUnended,
      returnsUnended: condState.returnsUnended || tState.returnsUnended || fState.returnsUnended,
      overwritten: condState.overwritten || tState.overwritten || fState.overwritten,
    };
  }

  if (ts.isBinaryExpression(unwrapped)) {
    const op = unwrapped.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      const leftState = evalExprWhileUnended(unwrapped.left, spanDecl, ctx);
      if (leftState.ended) {
        return leftState;
      }
      const rightState = evalExprWhileUnended(unwrapped.right, spanDecl, ctx);
      return {
        ended: false,
        throwsUnended: leftState.throwsUnended || rightState.throwsUnended,
        returnsUnended: leftState.returnsUnended || rightState.returnsUnended,
        overwritten: leftState.overwritten || rightState.overwritten,
      };
    }

    if (op === ts.SyntaxKind.EqualsToken) {
      const rightState = evalExprWhileUnended(unwrapped.right, spanDecl, ctx);
      const lhs = unwrapExpression(unwrapped.left);
      const overwritesSpan =
        !rightState.ended && ts.isIdentifier(lhs) && ctx.resolveIdentifier(lhs) === spanDecl;
      return {
        ended: rightState.ended,
        throwsUnended: rightState.throwsUnended,
        returnsUnended: rightState.returnsUnended,
        overwritten: rightState.overwritten || overwritesSpan,
      };
    }
  }

  let ended = false;
  let throwsUnended = false;
  let returnsUnended = false;
  let overwritten = false;

  ts.forEachChild(unwrapped, (child) => {
    if (ended) {
      return;
    }
    if (ts.isExpression(child)) {
      const sub = evalExprWhileUnended(child, spanDecl, ctx);
      if (sub.throwsUnended) {
        throwsUnended = true;
      }
      if (sub.returnsUnended) {
        returnsUnended = true;
      }
      if (sub.overwritten) {
        overwritten = true;
      }
      if (sub.ended) {
        ended = true;
      }
    }
  });

  return { ended, throwsUnended, returnsUnended, overwritten };
}

function evalReturnExpression(
  returnExpr: ts.Expression | undefined,
  spanDecl: ts.Node,
  ctx: OtelFileContext
): PathOutcome {
  if (!returnExpr) {
    return {
      fallsThroughUnended: false,
      returnsUnended: true,
      throwsUnended: false,
    };
  }

  if (isPromiseChainEndingSpan(returnExpr, spanDecl, ctx)) {
    return ENDED_CLEAN;
  }

  const exprState = evalExprWhileUnended(returnExpr, spanDecl, ctx);
  if (exprState.ended && !exprState.overwritten) {
    return {
      fallsThroughUnended: false,
      returnsUnended: exprState.returnsUnended,
      throwsUnended: exprState.throwsUnended,
    };
  }

  return {
    fallsThroughUnended: false,
    returnsUnended: true,
    throwsUnended: exprState.throwsUnended,
  };
}

function applyFinallyOutcome(
  bodyOutcome: PathOutcome,
  finallyOutcome: PathOutcome
): PathOutcome {
  if (isCleanOutcome(finallyOutcome)) {
    return ENDED_CLEAN;
  }
  return {
    fallsThroughUnended: bodyOutcome.fallsThroughUnended && finallyOutcome.fallsThroughUnended,
    returnsUnended: bodyOutcome.returnsUnended || finallyOutcome.returnsUnended,
    throwsUnended: bodyOutcome.throwsUnended || finallyOutcome.throwsUnended,
  };
}

function evalStatement(
  stmt: ts.Statement,
  spanDecl: ts.Node,
  ctx: OtelFileContext
): PathOutcome {
  if (ts.isBlock(stmt)) {
    return evalStatementList(stmt.statements, 0, spanDecl, ctx);
  }

  if (
    ts.isEmptyStatement(stmt) ||
    ts.isFunctionDeclaration(stmt) ||
    ts.isClassDeclaration(stmt) ||
    ts.isInterfaceDeclaration(stmt) ||
    ts.isTypeAliasDeclaration(stmt) ||
    ts.isEnumDeclaration(stmt)
  ) {
    return STILL_UNENDED;
  }

  if (ts.isExpressionStatement(stmt)) {
    const eState = evalExprWhileUnended(stmt.expression, spanDecl, ctx);
    if (eState.overwritten) {
      return {
        fallsThroughUnended: true,
        returnsUnended: true,
        throwsUnended: eState.throwsUnended,
      };
    }
    return {
      fallsThroughUnended: !eState.ended,
      returnsUnended: eState.returnsUnended,
      throwsUnended: eState.throwsUnended,
    };
  }

  if (ts.isVariableStatement(stmt)) {
    let ended = false;
    let throwsUnended = false;
    let returnsUnended = false;
    for (const decl of stmt.declarationList.declarations) {
      if (ended) {
        break;
      }
      if (decl.initializer) {
        const dState = evalExprWhileUnended(decl.initializer, spanDecl, ctx);
        if (dState.throwsUnended) {
          throwsUnended = true;
        }
        if (dState.returnsUnended) {
          returnsUnended = true;
        }
        if (dState.ended) {
          ended = true;
        }
      }
    }
    return {
      fallsThroughUnended: !ended,
      returnsUnended,
      throwsUnended,
    };
  }

  if (ts.isReturnStatement(stmt)) {
    return evalReturnExpression(stmt.expression, spanDecl, ctx);
  }

  if (ts.isThrowStatement(stmt)) {
    const eState = stmt.expression
      ? evalExprWhileUnended(stmt.expression, spanDecl, ctx)
      : { ended: false, throwsUnended: false, returnsUnended: false, overwritten: false };
    if (eState.ended && !eState.overwritten) {
      return {
        fallsThroughUnended: false,
        returnsUnended: eState.returnsUnended,
        throwsUnended: eState.throwsUnended,
      };
    }
    return {
      fallsThroughUnended: false,
      returnsUnended: false,
      throwsUnended: true,
    };
  }

  if (ts.isIfStatement(stmt)) {
    const condState = evalExprWhileUnended(stmt.expression, spanDecl, ctx);
    if (condState.ended && !condState.overwritten) {
      return {
        fallsThroughUnended: false,
        returnsUnended: condState.returnsUnended,
        throwsUnended: condState.throwsUnended,
      };
    }

    const thenRes = evalStatement(stmt.thenStatement, spanDecl, ctx);
    const elseRes = stmt.elseStatement
      ? evalStatement(stmt.elseStatement, spanDecl, ctx)
      : isTruthinessGuardForSpan(stmt.expression, spanDecl, ctx)
        ? ENDED_CLEAN
        : STILL_UNENDED;

    return {
      fallsThroughUnended: thenRes.fallsThroughUnended || elseRes.fallsThroughUnended,
      returnsUnended:
        condState.returnsUnended || thenRes.returnsUnended || elseRes.returnsUnended,
      throwsUnended:
        condState.throwsUnended || thenRes.throwsUnended || elseRes.throwsUnended,
    };
  }

  if (ts.isTryStatement(stmt)) {
    const tryRes = evalStatementList(stmt.tryBlock.statements, 0, spanDecl, ctx);
    const tryStartedImmediatelyWithEnd =
      stmt.tryBlock.statements.length > 0 &&
      ts.isExpressionStatement(stmt.tryBlock.statements[0]) &&
      isSpanEndCallOnDecl(stmt.tryBlock.statements[0].expression, spanDecl, ctx);

    let afterTryCatch: PathOutcome = tryRes;
    if (stmt.catchClause) {
      if (tryStartedImmediatelyWithEnd && isCleanOutcome(tryRes)) {
        afterTryCatch = tryRes;
      } else {
        const catchRes = evalStatementList(
          stmt.catchClause.block.statements,
          0,
          spanDecl,
          ctx
        );
        afterTryCatch = {
          fallsThroughUnended: tryRes.fallsThroughUnended || catchRes.fallsThroughUnended,
          returnsUnended: tryRes.returnsUnended || catchRes.returnsUnended,
          throwsUnended: catchRes.throwsUnended,
        };
      }
    }

    if (stmt.finallyBlock) {
      const finallyRes = evalStatementList(stmt.finallyBlock.statements, 0, spanDecl, ctx);
      return applyFinallyOutcome(afterTryCatch, finallyRes);
    }

    return afterTryCatch;
  }

  if (ts.isSwitchStatement(stmt)) {
    const discState = evalExprWhileUnended(stmt.expression, spanDecl, ctx);
    if (discState.ended) {
      return {
        fallsThroughUnended: false,
        returnsUnended: discState.returnsUnended,
        throwsUnended: discState.throwsUnended,
      };
    }

    let hasDefault = false;
    let anyFallthroughUnended = false;
    let anyReturnsUnended = discState.returnsUnended;
    let anyThrowsUnended = discState.throwsUnended;

    for (const clause of stmt.caseBlock.clauses) {
      if (ts.isDefaultClause(clause)) {
        hasDefault = true;
      }
      if (clause.statements.length === 0) {
        continue;
      }
      const cRes = evalStatementList(clause.statements, 0, spanDecl, ctx);
      if (cRes.fallsThroughUnended) {
        anyFallthroughUnended = true;
      }
      if (cRes.returnsUnended) {
        anyReturnsUnended = true;
      }
      if (cRes.throwsUnended) {
        anyThrowsUnended = true;
      }
    }

    if (!hasDefault) {
      anyFallthroughUnended = true;
    }

    return {
      fallsThroughUnended: anyFallthroughUnended,
      returnsUnended: anyReturnsUnended,
      throwsUnended: anyThrowsUnended,
    };
  }

  if (
    ts.isForStatement(stmt) ||
    ts.isForInStatement(stmt) ||
    ts.isForOfStatement(stmt) ||
    ts.isWhileStatement(stmt)
  ) {
    let headerThrows = false;
    if (ts.isForOfStatement(stmt) && stmt.awaitModifier !== undefined) {
      headerThrows = true;
    }
    if (ts.isForOfStatement(stmt) || ts.isForInStatement(stmt)) {
      const exprRes = evalExprWhileUnended(stmt.expression, spanDecl, ctx);
      if (exprRes.throwsUnended) {
        headerThrows = true;
      }
    } else if (ts.isWhileStatement(stmt)) {
      const condRes = evalExprWhileUnended(stmt.expression, spanDecl, ctx);
      if (condRes.throwsUnended) {
        headerThrows = true;
      }
    }
    const bodyRes = evalStatement(stmt.statement, spanDecl, ctx);
    return {
      fallsThroughUnended: true,
      returnsUnended: bodyRes.returnsUnended,
      throwsUnended: headerThrows || bodyRes.throwsUnended,
    };
  }

  if (ts.isDoStatement(stmt)) {
    const bodyRes = evalStatement(stmt.statement, spanDecl, ctx);
    const condThrows = bodyRes.fallsThroughUnended
      ? evalExprWhileUnended(stmt.expression, spanDecl, ctx).throwsUnended
      : false;
    return {
      fallsThroughUnended: bodyRes.fallsThroughUnended,
      returnsUnended: bodyRes.returnsUnended,
      throwsUnended: bodyRes.throwsUnended || condThrows,
    };
  }

  if (ts.isLabeledStatement(stmt)) {
    return evalStatement(stmt.statement, spanDecl, ctx);
  }

  return STILL_UNENDED;
}

function evalStatementList(
  stmts: readonly ts.Statement[],
  startIndex: number,
  spanDecl: ts.Node,
  ctx: OtelFileContext,
  initialState: PathOutcome = STILL_UNENDED
): PathOutcome {
  let currentlyUnended = initialState.fallsThroughUnended;
  let anyReturnsUnended = initialState.returnsUnended;
  let anyThrowsUnended = initialState.throwsUnended;

  for (let i = startIndex; i < stmts.length; i += 1) {
    if (!currentlyUnended) {
      break;
    }
    const stmt = stmts[i];
    if (ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt)) {
      break;
    }
    const res = evalStatement(stmt, spanDecl, ctx);
    if (res.returnsUnended) {
      anyReturnsUnended = true;
    }
    if (res.throwsUnended) {
      anyThrowsUnended = true;
    }
    currentlyUnended = res.fallsThroughUnended;
  }

  return {
    fallsThroughUnended: currentlyUnended,
    returnsUnended: anyReturnsUnended,
    throwsUnended: anyThrowsUnended,
  };
}

function findEnclosingStatement(node: ts.Node): ts.Statement | undefined {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (
      ts.isStatement(cur) &&
      !ts.isBlock(cur) &&
      cur.parent !== undefined &&
      (ts.isBlock(cur.parent) || ts.isSourceFile(cur.parent) || ts.isCaseClause(cur.parent) || ts.isDefaultClause(cur.parent))
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return undefined;
}

function evalFromStartStatementToScopeExit(
  startStmt: ts.Statement,
  spanDecl: ts.Node,
  ownerScope: ts.Node,
  ctx: OtelFileContext
): PathOutcome {
  let currentStmt: ts.Statement = startStmt;
  let state: PathOutcome = STILL_UNENDED;

  while (true) {
    const container = currentStmt.parent;
    if (!container) {
      return state;
    }

    if (ts.isBlock(container) || ts.isSourceFile(container) || ts.isCaseClause(container) || ts.isDefaultClause(container)) {
      const stmts = container.statements;
      const idx = stmts.indexOf(currentStmt);
      if (idx >= 0) {
        state = evalStatementList(stmts, idx + 1, spanDecl, ctx, state);
      }
    }

    if (container === ownerScope || container.parent === ownerScope) {
      return state;
    }

    const parentNode = container.parent;
    if (!parentNode) {
      return state;
    }

    if (ts.isTryStatement(parentNode)) {
      if (container === parentNode.tryBlock) {
        let afterTryCatch = state;
        if (parentNode.catchClause && (state.throwsUnended || state.fallsThroughUnended)) {
          const catchRes = evalStatementList(
            parentNode.catchClause.block.statements,
            0,
            spanDecl,
            ctx
          );
          afterTryCatch = {
            fallsThroughUnended: state.fallsThroughUnended || catchRes.fallsThroughUnended,
            returnsUnended: state.returnsUnended || catchRes.returnsUnended,
            throwsUnended: catchRes.throwsUnended,
          };
        }
        if (parentNode.finallyBlock) {
          const finallyRes = evalStatementList(
            parentNode.finallyBlock.statements,
            0,
            spanDecl,
            ctx
          );
          state = applyFinallyOutcome(afterTryCatch, finallyRes);
        } else {
          state = afterTryCatch;
        }
      } else if (
        parentNode.catchClause &&
        container === parentNode.catchClause.block &&
        parentNode.finallyBlock
      ) {
        const finallyRes = evalStatementList(
          parentNode.finallyBlock.statements,
          0,
          spanDecl,
          ctx
        );
        state = applyFinallyOutcome(state, finallyRes);
      }
      currentStmt = parentNode;
      continue;
    }

    if (ts.isStatement(parentNode)) {
      currentStmt = parentNode;
      continue;
    }

    const nextEnclosing = findEnclosingStatement(parentNode);
    if (!nextEnclosing || nextEnclosing === currentStmt) {
      return state;
    }
    currentStmt = nextEnclosing;
  }
}

type SpanTargetKey =
  | { readonly kind: 'decl'; readonly decl: ts.Node }
  | { readonly kind: 'thisField'; readonly cls: ts.ClassLikeDeclaration | undefined; readonly name: string }
  | { readonly kind: 'activeSpan' }
  | { readonly kind: 'raw'; readonly text: string };

function getSpanTargetKey(expr: ts.Expression, ctx: OtelFileContext): SpanTargetKey {
  const root = unwrapFluentSpanReceiver(expr);
  if (ts.isIdentifier(root)) {
    const decl = ctx.resolveIdentifier(root);
    if (decl) {
      return { kind: 'decl', decl };
    }
  }
  if (
    ts.isPropertyAccessExpression(root) &&
    root.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return {
      kind: 'thisField',
      cls: findEnclosingClass(root),
      name: root.name.text,
    };
  }
  if (ctx.isActiveSpanBorrowCall(root)) {
    return { kind: 'activeSpan' };
  }
  return { kind: 'raw', text: root.getText(ctx.sourceFile) };
}

function sameSpanTargetKey(a: SpanTargetKey, b: SpanTargetKey): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case 'decl':
      return a.decl === (b as typeof a).decl;
    case 'thisField':
      return a.cls === (b as typeof a).cls && a.name === (b as typeof a).name;
    case 'activeSpan':
      return true;
    case 'raw':
      return a.text === (b as typeof a).text;
  }
}

function findEnclosingCatchClauseInSameFunction(node: ts.Node): ts.CatchClause | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isCatchClause(cur)) {
      return cur;
    }
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isConstructorDeclaration(cur) ||
      ts.isGetAccessorDeclaration(cur) ||
      ts.isSetAccessorDeclaration(cur)
    ) {
      return undefined;
    }
    cur = cur.parent;
  }
  return undefined;
}

function isValidErrorStatusArgument(
  statusArg: ts.Expression | undefined,
  ctx: OtelFileContext,
  visitedDecls = new Set<ts.Node>()
): boolean {
  if (!statusArg) {
    return false;
  }
  const unwrapped = unwrapExpression(statusArg);

  if (ts.isObjectLiteralExpression(unwrapped)) {
    let foundCodeProp = false;
    let hasSpread = false;

    for (const prop of unwrapped.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const propName =
          ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)
            ? prop.name.text
            : undefined;
        if (propName === 'code') {
          foundCodeProp = true;
          const classification = ctx.classifyStatusCodeExpr(prop.initializer);
          return classification === 'ERROR' || classification === 'DYNAMIC';
        }
      } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'code') {
        foundCodeProp = true;
        const classification = ctx.classifyStatusCodeExpr(prop.name);
        return classification === 'ERROR' || classification === 'DYNAMIC';
      } else if (ts.isSpreadAssignment(prop)) {
        hasSpread = true;
        if (ts.isIdentifier(unwrapExpression(prop.expression))) {
          const spreadId = unwrapExpression(prop.expression) as ts.Identifier;
          const decl = ctx.resolveIdentifier(spreadId);
          if (
            decl &&
            !visitedDecls.has(decl) &&
            ts.isVariableDeclaration(decl) &&
            decl.initializer &&
            ts.isObjectLiteralExpression(unwrapExpression(decl.initializer))
          ) {
            visitedDecls.add(decl);
            if (isValidErrorStatusArgument(decl.initializer, ctx, visitedDecls)) {
              return true;
            }
            hasSpread = false;
          }
        }
      }
    }

    if (!foundCodeProp && hasSpread) {
      return true;
    }
    return false;
  }

  if (ts.isIdentifier(unwrapped)) {
    const decl = ctx.resolveIdentifier(unwrapped);
    if (
      decl &&
      !visitedDecls.has(decl) &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      ts.isVariableDeclarationList(decl.parent) &&
      (decl.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      visitedDecls.add(decl);
      return isValidErrorStatusArgument(decl.initializer, ctx, visitedDecls);
    }
    return true;
  }

  return true;
}

function catchClauseEscapesOrSetsErrorStatus(
  catchClause: ts.CatchClause,
  targetKey: SpanTargetKey,
  ctx: OtelFileContext
): boolean {
  let satisfied = false;

  const visit = (node: ts.Node): void => {
    if (satisfied) {
      return;
    }
    if (
      node !== catchClause.block &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node))
    ) {
      return;
    }

    if (ts.isCallExpression(node)) {
      if (!ctx.isTraceSetSpanCall(node)) {
        for (const arg of node.arguments) {
          const unwrappedArg = unwrapExpression(arg);
          if (ctx.isSpanExpr(unwrappedArg)) {
            const argKey = getSpanTargetKey(unwrappedArg, ctx);
            if (sameSpanTargetKey(targetKey, argKey)) {
              satisfied = true;
              return;
            }
          }
        }
      }

      const callee = unwrapExpression(node.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'setStatus') {
        const recv = callee.expression;
        if (ctx.isSpanExpr(recv)) {
          const recvKey = getSpanTargetKey(recv, ctx);
          if (
            sameSpanTargetKey(targetKey, recvKey) &&
            isValidErrorStatusArgument(node.arguments[0], ctx)
          ) {
            satisfied = true;
            return;
          }
        }
      }
    } else if (ts.isNewExpression(node) && node.arguments) {
      for (const arg of node.arguments) {
        const unwrappedArg = unwrapExpression(arg);
        if (ctx.isSpanExpr(unwrappedArg)) {
          const argKey = getSpanTargetKey(unwrappedArg, ctx);
          if (sameSpanTargetKey(targetKey, argKey)) {
            satisfied = true;
            return;
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(catchClause.block);
  return satisfied;
}

function createFinding(
  ruleId: RuleId,
  message: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
  displayPath: string
): Finding {
  const rule = RULE_MAP.get(ruleId)!;
  const startPos = node.getStart(sourceFile);
  const endPos = node.getEnd();
  const startLoc = sourceFile.getLineAndCharacterOfPosition(startPos);
  const endLoc = sourceFile.getLineAndCharacterOfPosition(endPos);

  return {
    ruleId,
    severity: rule.defaultSeverity,
    message,
    file: displayPath.replaceAll('\\', '/'),
    line: startLoc.line + 1,
    column: startLoc.character + 1,
    endLine: endLoc.line + 1,
    endColumn: endLoc.character + 1,
  };
}

function analyzeFileWithContext(ctx: OtelFileContext, displayPath: string): Finding[] {
  if (!ctx.hasOtelImport) {
    return [];
  }

  const findings: Finding[] = [];
  const { sourceFile } = ctx;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);

      // OTL001: Local startSpan() missing span.end() on at least one path
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'startSpan' &&
        ctx.isTracerExpr(callee.expression)
      ) {
        const chainTop = walkUpFluentSpanCalls(node);
        if (!isImmediateChainedEndCall(chainTop) && !doesValueExpressionEscape(chainTop, ctx)) {
          const parent = chainTop.parent;
          const ownerScope = findEnclosingFunctionOrSource(node);

          if (
            parent &&
            ts.isVariableDeclaration(parent) &&
            parent.initializer !== undefined &&
            walkUpParensAndAssertions(parent.initializer) === chainTop &&
            ts.isIdentifier(parent.name)
          ) {
            const spanDecl = parent;
            if (!doesSpanBindingEscape(spanDecl, ownerScope, undefined, ctx)) {
              const startStmt = findEnclosingStatement(parent);
              if (startStmt) {
                const outcome = evalFromStartStatementToScopeExit(
                  startStmt,
                  spanDecl,
                  ownerScope,
                  ctx
                );
                if (!isCleanOutcome(outcome)) {
                  findings.push(
                    createFinding(
                      'OTL001',
                      `Local OpenTelemetry span "${parent.name.text}" from startSpan() is not guaranteed to call span.end() on every execution path (wrap work in try/finally or end on all paths).`,
                      node,
                      sourceFile,
                      displayPath
                    )
                  );
                }
              }
            }
          } else if (
            parent &&
            ts.isBinaryExpression(parent) &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            walkUpParensAndAssertions(parent.right) === chainTop &&
            ts.isIdentifier(unwrapExpression(parent.left))
          ) {
            const lhsIdent = unwrapExpression(parent.left) as ts.Identifier;
            const spanDecl = ctx.resolveIdentifier(lhsIdent);
            if (spanDecl && !doesSpanBindingEscape(spanDecl, ownerScope, lhsIdent, ctx)) {
              const startStmt = findEnclosingStatement(parent);
              if (startStmt) {
                const outcome = evalFromStartStatementToScopeExit(
                  startStmt,
                  spanDecl,
                  ownerScope,
                  ctx
                );
                if (!isCleanOutcome(outcome)) {
                  findings.push(
                    createFinding(
                      'OTL001',
                      `Local OpenTelemetry span "${lhsIdent.text}" from startSpan() is not guaranteed to call span.end() on every execution path (wrap work in try/finally or end on all paths).`,
                      node,
                      sourceFile,
                      displayPath
                    )
                  );
                }
              }
            }
          } else {
            findings.push(
              createFinding(
                'OTL001',
                'Unassigned OpenTelemetry span from startSpan() is never ended via span.end().',
                node,
                sourceFile,
                displayPath
              )
            );
          }
        }
      }

      // OTL002: startActiveSpan(name, [opts], [ctx], fn) callback missing guaranteed span.end()
      if (ctx.isStartActiveSpanCall(node) && node.arguments.length >= 2) {
        const lastArg = unwrapExpression(node.arguments[node.arguments.length - 1]);
        if (ts.isArrowFunction(lastArg) || ts.isFunctionExpression(lastArg)) {
          if (lastArg.parameters.length === 0) {
            const escapesViaArguments =
              ts.isFunctionExpression(lastArg) && functionUsesOwnArgumentsObject(lastArg);
            if (!escapesViaArguments) {
              findings.push(
                createFinding(
                  'OTL002',
                  'startActiveSpan() callback omits the span parameter and never calls span.end() (OpenTelemetry JS does not auto-end active spans).',
                  node,
                  sourceFile,
                  displayPath
                )
              );
            }
          } else {
            const firstParam = lastArg.parameters[0];
            if (firstParam && ts.isIdentifier(firstParam.name)) {
              if (!doesSpanBindingEscape(firstParam, lastArg, undefined, ctx)) {
                const outcome = evalInlineFunctionBody(lastArg, firstParam, ctx);
                if (!isCleanOutcome(outcome)) {
                  findings.push(
                    createFinding(
                      'OTL002',
                      `startActiveSpan() callback parameter "${firstParam.name.text}" is not guaranteed to call span.end() on every execution and await/rejection path (use try/finally).`,
                      node,
                      sourceFile,
                      displayPath
                    )
                  );
                }
              }
            }
          }
        }
      }

      // OTL003: span.recordException(err) in catch without span.setStatus({ code: SpanStatusCode.ERROR })
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'recordException' &&
        ctx.isSpanExpr(callee.expression)
      ) {
        const catchClause = findEnclosingCatchClauseInSameFunction(node);
        if (catchClause) {
          const targetKey = getSpanTargetKey(callee.expression, ctx);
          if (!catchClauseEscapesOrSetsErrorStatus(catchClause, targetKey, ctx)) {
            findings.push(
              createFinding(
                'OTL003',
                'span.recordException() inside catch block without setting SpanStatusCode.ERROR (2) via span.setStatus({ code: SpanStatusCode.ERROR }) in the same catch block.',
                node,
                sourceFile,
                displayPath
              )
            );
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

export function analyzeSourceFile(
  filePath: string,
  content: string,
  displayPath: string = filePath
): Finding[] {
  const sf = parseSourceFile(filePath, content);
  const ctx = new OtelFileContext(sf, filePath);
  const findings = analyzeFileWithContext(ctx, displayPath);
  findings.sort((a, b) =>
    a.file !== b.file
      ? a.file < b.file
        ? -1
        : 1
      : a.line !== b.line
        ? a.line - b.line
        : a.column - b.column
  );
  return findings;
}

export function analyzeSources(
  sources: readonly SourceInput[],
  _options: AnalyzerOptions = {}
): Finding[] {
  const parsedList = sources.map((src) => ({
    src,
    sf: parseSourceFile(src.absolutePath, src.content),
  }));

  const exportMap = new Map<string, CrossFileOtelExports>();
  for (const item of parsedList) {
    const preCtx = new OtelFileContext(item.sf, item.src.absolutePath);
    if (preCtx.hasOtelImport) {
      exportMap.set(
        normalizeModuleLookupKey(item.src.absolutePath),
        preCtx.collectModuleExports()
      );
    }
  }

  const crossExports: CrossFileExportMap = exportMap;
  const allFindings: Finding[] = [];

  for (const item of parsedList) {
    const ctx = new OtelFileContext(item.sf, item.src.absolutePath, crossExports);
    const fileFindings = analyzeFileWithContext(ctx, item.src.displayPath);
    allFindings.push(...fileFindings);
  }

  allFindings.sort((a, b) =>
    a.file !== b.file
      ? a.file < b.file
        ? -1
        : 1
      : a.line !== b.line
        ? a.line - b.line
        : a.column !== b.column
          ? a.column - b.column
          : a.ruleId < b.ruleId
            ? -1
            : a.ruleId > b.ruleId
              ? 1
              : 0
  );

  return allFindings;
}
