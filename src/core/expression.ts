/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type ExpressionValue = number | number[] | boolean;

export interface ExpressionContext {
  time: number;
  progress: number;
  duration: number;
  seed?: number;
  inputs?: Record<string, ExpressionValue>;
  constants?: Record<string, ExpressionValue>;
  maxOperations?: number;
}

type TokenKind = 'number' | 'identifier' | 'operator' | 'eof';
interface Token {
  kind: TokenKind;
  text: string;
  value?: number;
}

type Node =
  | { kind: 'literal'; value: ExpressionValue }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; operator: string; value: Node }
  | { kind: 'binary'; operator: string; left: Node; right: Node }
  | { kind: 'conditional'; condition: Node; yes: Node; no: Node }
  | { kind: 'call'; name: string; args: Node[] };

export class SafeExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeExpressionError';
  }
}

function tokenize(source: string): Token[] {
  if (source.length > 1024) throw new SafeExpressionError('Expression exceeds 1024 characters');
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    if (/\s/.test(char)) {
      cursor += 1;
      continue;
    }
    const number = source.slice(cursor).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
    if (number) {
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw new SafeExpressionError('Number must be finite');
      tokens.push({ kind: 'number', text: number[0], value });
      cursor += number[0].length;
      continue;
    }
    const identifier = source.slice(cursor).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (identifier) {
      tokens.push({ kind: 'identifier', text: identifier[0] });
      cursor += identifier[0].length;
      continue;
    }
    const two = source.slice(cursor, cursor + 2);
    if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) {
      tokens.push({ kind: 'operator', text: two });
      cursor += 2;
      continue;
    }
    if ('+-*/%^(),?:<>!'.includes(char)) {
      tokens.push({ kind: 'operator', text: char });
      cursor += 1;
      continue;
    }
    throw new SafeExpressionError(`Unsupported token "${char}"`);
  }
  if (tokens.length > 512) throw new SafeExpressionError('Expression exceeds 512 tokens');
  tokens.push({ kind: 'eof', text: '' });
  return tokens;
}

class Parser {
  private cursor = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.parseConditional();
    if (this.peek().kind !== 'eof') {
      throw new SafeExpressionError(`Unexpected token "${this.peek().text}"`);
    }
    return node;
  }

  private withDepth<T>(read: () => T): T {
    this.depth += 1;
    if (this.depth > 32) throw new SafeExpressionError('Expression nesting exceeds 32');
    try {
      return read();
    } finally {
      this.depth -= 1;
    }
  }

  private peek(): Token {
    return this.tokens[this.cursor];
  }

  private take(text?: string): Token {
    const token = this.peek();
    if (text !== undefined && token.text !== text) {
      throw new SafeExpressionError(`Expected "${text}", got "${token.text}"`);
    }
    this.cursor += 1;
    return token;
  }

  private match(text: string): boolean {
    if (this.peek().text !== text) return false;
    this.cursor += 1;
    return true;
  }

  private parseConditional(): Node {
    let node = this.parseOr();
    if (this.match('?')) {
      const yes = this.withDepth(() => this.parseConditional());
      this.take(':');
      const no = this.withDepth(() => this.parseConditional());
      node = { kind: 'conditional', condition: node, yes, no };
    }
    return node;
  }

  private parseOr(): Node {
    return this.parseBinary(() => this.parseAnd(), ['||']);
  }

  private parseAnd(): Node {
    return this.parseBinary(() => this.parseEquality(), ['&&']);
  }

  private parseEquality(): Node {
    return this.parseBinary(() => this.parseComparison(), ['==', '!=']);
  }

  private parseComparison(): Node {
    return this.parseBinary(() => this.parseAdditive(), ['<', '<=', '>', '>=']);
  }

  private parseAdditive(): Node {
    return this.parseBinary(() => this.parseMultiplicative(), ['+', '-']);
  }

  private parseMultiplicative(): Node {
    return this.parseBinary(() => this.parsePower(), ['*', '/', '%']);
  }

  private parsePower(): Node {
    const left = this.parseUnary();
    if (!this.match('^')) return left;
    return { kind: 'binary', operator: '^', left, right: this.parsePower() };
  }

  private parseBinary(read: () => Node, operators: string[]): Node {
    let node = read();
    while (operators.includes(this.peek().text)) {
      const operator = this.take().text;
      node = { kind: 'binary', operator, left: node, right: read() };
    }
    return node;
  }

  private parseUnary(): Node {
    if (['+', '-', '!'].includes(this.peek().text)) {
      return {
        kind: 'unary',
        operator: this.take().text,
        value: this.withDepth(() => this.parseUnary()),
      };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const token = this.peek();
    if (token.kind === 'number') {
      this.take();
      return { kind: 'literal', value: token.value! };
    }
    if (token.kind === 'identifier') {
      const name = this.take().text;
      if (!this.match('(')) return { kind: 'variable', name };
      const args: Node[] = [];
      if (!this.match(')')) {
        do {
          args.push(this.withDepth(() => this.parseConditional()));
        } while (this.match(','));
        this.take(')');
      }
      return { kind: 'call', name, args };
    }
    if (this.match('(')) {
      const node = this.withDepth(() => this.parseConditional());
      this.take(')');
      return node;
    }
    throw new SafeExpressionError(`Expected a value, got "${token.text}"`);
  }
}

function scalar(value: ExpressionValue, label = 'value'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SafeExpressionError(`${label} must be a finite number`);
  }
  return value;
}

function truthy(value: ExpressionValue): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value.some((part) => part !== 0);
}

function mapBinary(
  left: ExpressionValue,
  right: ExpressionValue,
  operation: (a: number, b: number) => number,
): ExpressionValue {
  if (typeof left === 'number' && typeof right === 'number') return operation(left, right);
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    throw new SafeExpressionError('Boolean arithmetic is not supported');
  }
  const size = Array.isArray(left) ? left.length : Array.isArray(right) ? right.length : 0;
  const a = Array.isArray(left) ? left : Array.from({ length: size }, () => left);
  const b = Array.isArray(right) ? right : Array.from({ length: size }, () => right);
  if (a.length !== b.length) throw new SafeExpressionError('Vector dimensions must match');
  return a.map((part, index) => operation(part, b[index]));
}

function deterministicNoise(value: number, seed: number): number {
  const x = Math.sin(value * 12.9898 + seed * 78.233) * 43758.5453123;
  return (x - Math.floor(x)) * 2 - 1;
}

const functions: Record<string, (args: ExpressionValue[], seed: number) => ExpressionValue> = {
  abs: ([x]) => Math.abs(scalar(x)),
  sin: ([x]) => Math.sin(scalar(x)),
  cos: ([x]) => Math.cos(scalar(x)),
  tan: ([x]) => Math.tan(scalar(x)),
  sqrt: ([x]) => Math.sqrt(Math.max(0, scalar(x))),
  floor: ([x]) => Math.floor(scalar(x)),
  ceil: ([x]) => Math.ceil(scalar(x)),
  round: ([x]) => Math.round(scalar(x)),
  sign: ([x]) => Math.sign(scalar(x)),
  min: (args) => Math.min(...args.map((value) => scalar(value))),
  max: (args) => Math.max(...args.map((value) => scalar(value))),
  pow: ([x, y]) => Math.pow(scalar(x), scalar(y)),
  clamp: ([x, low, high]) => Math.max(scalar(low), Math.min(scalar(high), scalar(x))),
  lerp: ([a, b, t]) => mapBinary(a, b, (x, y) => x + (y - x) * scalar(t)),
  map: ([x, inA, inB, outA, outB]) => {
    const denominator = scalar(inB) - scalar(inA);
    if (Math.abs(denominator) < 1e-12) return scalar(outA);
    const t = (scalar(x) - scalar(inA)) / denominator;
    return scalar(outA) + (scalar(outB) - scalar(outA)) * t;
  },
  smoothstep: ([low, high, x]) => {
    const span = scalar(high) - scalar(low);
    const t = span === 0 ? 0 : Math.max(0, Math.min(1, (scalar(x) - scalar(low)) / span));
    return t * t * (3 - 2 * t);
  },
  noise: ([x], seed) => deterministicNoise(scalar(x), seed),
  vec2: (args) => args.slice(0, 2).map((value) => scalar(value)),
  vec3: (args) => args.slice(0, 3).map((value) => scalar(value)),
  vec4: (args) => args.slice(0, 4).map((value) => scalar(value)),
  length: ([value]) => {
    if (!Array.isArray(value)) return Math.abs(scalar(value));
    return Math.hypot(...value);
  },
  normalize: ([value]) => {
    if (!Array.isArray(value)) return Math.sign(scalar(value));
    const length = Math.hypot(...value);
    return length === 0 ? value.map(() => 0) : value.map((part) => part / length);
  },
  dot: ([a, b]) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      throw new SafeExpressionError('dot requires vectors with matching dimensions');
    }
    return a.reduce((sum, part, index) => sum + part * b[index], 0);
  },
};

function evaluateNode(
  node: Node,
  variables: Record<string, ExpressionValue>,
  seed: number,
  budget: { remaining: number },
): ExpressionValue {
  budget.remaining -= 1;
  if (budget.remaining < 0) throw new SafeExpressionError('Expression operation budget exceeded');
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'variable': {
      const value = variables[node.name];
      if (value === undefined) throw new SafeExpressionError(`Unknown variable "${node.name}"`);
      return value;
    }
    case 'unary': {
      const value = evaluateNode(node.value, variables, seed, budget);
      if (node.operator === '!') return !truthy(value);
      if (node.operator === '+') return scalar(value);
      return mapBinary(0, value, (a, b) => a - b);
    }
    case 'conditional':
      return truthy(evaluateNode(node.condition, variables, seed, budget))
        ? evaluateNode(node.yes, variables, seed, budget)
        : evaluateNode(node.no, variables, seed, budget);
    case 'call': {
      const fn = functions[node.name];
      if (!fn) throw new SafeExpressionError(`Function "${node.name}" is not allowed`);
      return fn(node.args.map((arg) => evaluateNode(arg, variables, seed, budget)), seed);
    }
    case 'binary': {
      if (node.operator === '&&') {
        return truthy(evaluateNode(node.left, variables, seed, budget)) &&
          truthy(evaluateNode(node.right, variables, seed, budget));
      }
      if (node.operator === '||') {
        return truthy(evaluateNode(node.left, variables, seed, budget)) ||
          truthy(evaluateNode(node.right, variables, seed, budget));
      }
      const left = evaluateNode(node.left, variables, seed, budget);
      const right = evaluateNode(node.right, variables, seed, budget);
      switch (node.operator) {
        case '+': return mapBinary(left, right, (a, b) => a + b);
        case '-': return mapBinary(left, right, (a, b) => a - b);
        case '*': return mapBinary(left, right, (a, b) => a * b);
        case '/': return mapBinary(left, right, (a, b) => b === 0 ? 0 : a / b);
        case '%': return mapBinary(left, right, (a, b) => b === 0 ? 0 : a % b);
        case '^': return mapBinary(left, right, (a, b) => Math.pow(a, b));
        case '==': return JSON.stringify(left) === JSON.stringify(right);
        case '!=': return JSON.stringify(left) !== JSON.stringify(right);
        case '<': return scalar(left) < scalar(right);
        case '<=': return scalar(left) <= scalar(right);
        case '>': return scalar(left) > scalar(right);
        case '>=': return scalar(left) >= scalar(right);
        default: throw new SafeExpressionError(`Unsupported operator "${node.operator}"`);
      }
    }
  }
}

export function evaluateExpression(source: string, context: ExpressionContext): ExpressionValue {
  const ast = new Parser(tokenize(source)).parse();
  const maxOperations = Math.max(16, Math.min(10_000, context.maxOperations ?? 256));
  const variables: Record<string, ExpressionValue> = {
    time: context.time,
    progress: context.progress,
    duration: context.duration,
    seed: context.seed ?? 0,
    pi: Math.PI,
    tau: Math.PI * 2,
    e: Math.E,
    true: true,
    false: false,
    ...context.constants,
    ...context.inputs,
  };
  const result = evaluateNode(ast, variables, context.seed ?? 0, { remaining: maxOperations });
  if (
    (typeof result === 'number' && !Number.isFinite(result)) ||
    (Array.isArray(result) && result.some((part) => !Number.isFinite(part)))
  ) {
    throw new SafeExpressionError('Expression produced a non-finite result');
  }
  return result;
}
