import { parse } from "acorn";

type Node = { type: string; start: number; end: number; [key: string]: unknown };

export type JavaScriptIssue = { message: string; start: number; end: number };
export type SafeJavaScript = {
  ok: true;
  declared: string[];
  bindingNames: string[];
  executable: string;
  biolangSource: string;
} | { ok: false; issues: JavaScriptIssue[] };

const FORBIDDEN_PROPERTIES = new Set(["__proto__", "prototype", "constructor"]);
const BLOCKED_BL_METHODS = new Set([
  "connectSomer", "define", "exportVariable", "invoke", "raw", "ref", "registerModule", "reset", "run",
]);
const GLOBAL_NAMES = new Set([
  "document", "eval", "fetch", "Function", "globalThis", "importScripts", "location",
  "navigator", "self", "WebAssembly", "window", "Worker", "XMLHttpRequest",
]);
const UNARY_OPERATORS = new Set(["!", "+", "-"]);
const BINARY_OPERATORS = new Set([
  "+", "-", "*", "/", "%", "**", "==", "!=", "===", "!==", "<", "<=", ">", ">=",
]);
const LOGICAL_OPERATORS = new Set(["&&", "||", "??"]);

function issue(node: Node, message: string): JavaScriptIssue {
  return { message, start: node.start, end: Math.max(node.end, node.start + 1) };
}

function propertyName(node: Node): string | null {
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

/**
 * Validate the deliberately small JavaScript notebook frontend. It permits data
 * literals, variables, field reads, pure operators, and calls through `bl`.
 * Browser globals, mutation, user functions, dynamic code, and arbitrary calls
 * are rejected before `new Function` is reached in the worker.
 */
export function compileSafeJavaScript(source: string, priorNames: Iterable<string> = []): SafeJavaScript {
  let program: Node;
  try {
    program = parse(source, {
      ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true,
    }) as unknown as Node;
  } catch (error) {
    const parsed = error as Error & { pos?: number; raisedAt?: number };
    const start = parsed.pos ?? 0;
    return { ok: false, issues: [{ message: parsed.message, start, end: Math.max(parsed.raisedAt ?? start + 1, start + 1) }] };
  }

  const issues: JavaScriptIssue[] = [];
  const known = new Set(["bl", ...priorNames]);
  const declared: string[] = [];

  const validateExpression = (node: Node): void => {
    switch (node.type) {
      case "Literal": {
        const value = node.value;
        if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
          issues.push(issue(node, "Only string, number, boolean, and null literals are supported."));
        }
        return;
      }
      case "Identifier": {
        const name = String(node.name);
        if (GLOBAL_NAMES.has(name) || !known.has(name)) issues.push(issue(node, `Unknown or unavailable name '${name}'. Use a previous cell variable or the bl API.`));
        return;
      }
      case "ArrayExpression":
        for (const element of (node.elements as Array<Node | null>)) {
          if (element) validateExpression(element);
        }
        return;
      case "ObjectExpression":
        for (const property of node.properties as Node[]) {
          if (property.type !== "Property" || property.kind !== "init" || property.method || property.computed) {
            issues.push(issue(property, "Only ordinary object fields are supported."));
            continue;
          }
          const name = propertyName(property.key as Node);
          if (!name || FORBIDDEN_PROPERTIES.has(name)) issues.push(issue(property, "This object field is not allowed."));
          validateExpression(property.value as Node);
        }
        return;
      case "AwaitExpression": validateExpression(node.argument as Node); return;
      case "UnaryExpression":
        if (!UNARY_OPERATORS.has(String(node.operator))) issues.push(issue(node, `Unary operator '${String(node.operator)}' is not supported.`));
        validateExpression(node.argument as Node); return;
      case "BinaryExpression":
        if (!BINARY_OPERATORS.has(String(node.operator))) issues.push(issue(node, `Operator '${String(node.operator)}' is not supported.`));
        validateExpression(node.left as Node); validateExpression(node.right as Node); return;
      case "LogicalExpression":
        if (!LOGICAL_OPERATORS.has(String(node.operator))) issues.push(issue(node, `Operator '${String(node.operator)}' is not supported.`));
        validateExpression(node.left as Node); validateExpression(node.right as Node); return;
      case "ConditionalExpression":
        validateExpression(node.test as Node); validateExpression(node.consequent as Node); validateExpression(node.alternate as Node); return;
      case "MemberExpression": {
        validateExpression(node.object as Node);
        const property = node.property as Node;
        const name = propertyName(property);
        if (node.computed && property.type !== "Literal") issues.push(issue(property, "Computed fields must use a literal string or number."));
        if (name && FORBIDDEN_PROPERTIES.has(name)) issues.push(issue(property, `Field '${name}' is not available.`));
        if (node.computed && property.type === "Literal" && typeof property.value !== "string" && typeof property.value !== "number") {
          issues.push(issue(property, "Computed fields must use a literal string or number."));
        }
        return;
      }
      case "CallExpression": {
        if (node.optional) issues.push(issue(node, "Optional calls are not supported."));
        const callee = node.callee as Node;
        const directBlCall = callee.type === "MemberExpression" && !callee.computed &&
          (callee.object as Node).type === "Identifier" && (callee.object as Node).name === "bl";
        const method = directBlCall ? propertyName(callee.property as Node) : null;
        if (!method || FORBIDDEN_PROPERTIES.has(method) || BLOCKED_BL_METHODS.has(method)) {
          issues.push(issue(callee, "Calls must use a supported bl method, such as bl.mean(values)."));
        }
        for (const argument of node.arguments as Node[]) {
          if (argument.type === "SpreadElement") issues.push(issue(argument, "Spread arguments are not supported."));
          else validateExpression(argument);
        }
        return;
      }
      case "ChainExpression": validateExpression(node.expression as Node); return;
      default:
        issues.push(issue(node, `${node.type.replace(/Expression$/, "")} is not supported in a safe JavaScript notebook cell.`));
    }
  };

  const body = program.body as Node[];
  for (const statement of body) {
    if (statement.type === "VariableDeclaration") {
      if (statement.kind !== "let" && statement.kind !== "const") {
        issues.push(issue(statement, "Use let or const for notebook variables."));
      }
      for (const declaration of statement.declarations as Node[]) {
        const identifier = declaration.id as Node;
        if (identifier.type !== "Identifier") {
          issues.push(issue(identifier, "Destructuring declarations are not supported yet."));
          continue;
        }
        const name = String(identifier.name);
        if (name === "bl" || GLOBAL_NAMES.has(name)) issues.push(issue(identifier, `Variable name '${name}' is reserved.`));
        if (!declaration.init) issues.push(issue(declaration, "Notebook variables need an initial value."));
        else validateExpression(declaration.init as Node);
        known.add(name);
        declared.push(name);
      }
    } else if (statement.type === "ExpressionStatement") {
      validateExpression(statement.expression as Node);
    } else if (statement.type !== "EmptyStatement") {
      issues.push(issue(statement, `${statement.type.replace(/Statement$/, "")} statements are not supported in safe JavaScript cells.`));
    }
  }

  const last = [...body].reverse().find(statement => statement.type !== "EmptyStatement");
  if (!last || last.type !== "ExpressionStatement") {
    issues.push(issue(last ?? program, "End the cell with the value you want to display."));
  }
  if (issues.length) return { ok: false, issues };

  const expressionSource = (node: Node): string => {
    switch (node.type) {
      case "Literal": return node.value === null ? "nil" : typeof node.value === "string" ? JSON.stringify(node.value) : String(node.value);
      case "Identifier": return String(node.name);
      case "ArrayExpression": return `[${(node.elements as Array<Node | null>).map(element => element ? expressionSource(element) : "nil").join(", ")}]`;
      case "ObjectExpression": return `{${(node.properties as Node[]).map(property => {
        const key = propertyName(property.key as Node)!;
        const renderedKey = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);
        return `${renderedKey}: ${expressionSource(property.value as Node)}`;
      }).join(", ")}}`;
      case "AwaitExpression": return expressionSource(node.argument as Node);
      case "UnaryExpression": {
        const operator = String(node.operator) === "!" ? "not " : String(node.operator);
        return `(${operator}${expressionSource(node.argument as Node)})`;
      }
      case "BinaryExpression": {
        const operators: Record<string, string> = { "===": "==", "!==": "!=" };
        return `(${expressionSource(node.left as Node)} ${operators[String(node.operator)] ?? String(node.operator)} ${expressionSource(node.right as Node)})`;
      }
      case "LogicalExpression": {
        const operators: Record<string, string> = { "&&": "and", "||": "or" };
        return `(${expressionSource(node.left as Node)} ${operators[String(node.operator)] ?? String(node.operator)} ${expressionSource(node.right as Node)})`;
      }
      case "ConditionalExpression": return `(${expressionSource(node.consequent as Node)} if ${expressionSource(node.test as Node)} else ${expressionSource(node.alternate as Node)})`;
      case "MemberExpression": {
        const object = expressionSource(node.object as Node);
        if (node.computed) return `(${object})[${expressionSource(node.property as Node)}]`;
        return `(${object}).${propertyName(node.property as Node)}`;
      }
      case "CallExpression": {
        const callee = node.callee as Node;
        const method = propertyName((callee.property as Node));
        return `${method}(${(node.arguments as Node[]).map(expressionSource).join(", ")})`;
      }
      case "ChainExpression": return expressionSource(node.expression as Node);
      default: throw new Error(`Validated JavaScript node '${node.type}' has no BioLang renderer.`);
    }
  };

  const lines: string[] = [];
  for (const statement of body) {
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations as Node[]) {
        lines.push(`let ${String((declaration.id as Node).name)} = ${expressionSource(declaration.init as Node)}`);
      }
    } else if (statement.type === "ExpressionStatement") {
      lines.push(expressionSource(statement.expression as Node));
    }
  }

  const resultExpression = (last as Node).expression as Node;
  const bindingNames = [...declared];
  const beforeResult = source.slice(0, last!.start);
  const expression = source.slice(resultExpression.start, resultExpression.end);
  const executable = `${beforeResult}\nreturn { result: (${expression}), bindings: { ${bindingNames.join(", ")} } };`;
  return { ok: true, declared, bindingNames, executable, biolangSource: lines.join("\n") };
}
