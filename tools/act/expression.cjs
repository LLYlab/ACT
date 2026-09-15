'use strict'
// ACT when-表达式：词法 / 语法 / 分析 / 求值
// 文法见 ACT-校验器规格.md §4.1，求值语义见 §4.2

class ParseError extends Error {
  constructor (message, pos) { super(message); this.name = 'ParseError'; this.pos = pos }
}
class EvalFail extends Error {
  constructor (message) { super(message); this.name = 'EvalFail' }
}

// ── 词法 ──────────────────────────────────────────────────────────────────
const KW = new Set(['and', 'or', 'not'])
const ALPHA_OPS = new Set(['in', 'startsWith'])
const SYMBOL_OPS = ['==', '!=', '>', '<']

function tokenize (src) {
  const toks = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === '(') { toks.push({ t: 'lparen', pos: i }); i++; continue }
    if (c === ')') { toks.push({ t: 'rparen', pos: i }); i++; continue }
    if (c === '[') { toks.push({ t: 'lbracket', pos: i }); i++; continue }
    if (c === ']') { toks.push({ t: 'rbracket', pos: i }); i++; continue }
    if (c === ',') { toks.push({ t: 'comma', pos: i }); i++; continue }

    if (c === "'" || c === '"') {
      const q = c; let j = i + 1; let s = ''
      while (j < src.length && src[j] !== q) { s += src[j]; j++ }
      if (j >= src.length) throw new ParseError('未闭合的字符串', i)
      toks.push({ t: 'string', value: s, pos: i }); i = j + 1; continue
    }

    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1
      while (j < src.length && /[0-9.]/.test(src[j])) j++
      toks.push({ t: 'number', value: Number(src.slice(i, j)), pos: i }); i = j; continue
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++
      const word = src.slice(i, j)
      if (KW.has(word)) toks.push({ t: 'kw', value: word, pos: i })
      else if (word === 'true' || word === 'false') toks.push({ t: 'bool', value: word === 'true', pos: i })
      else if (ALPHA_OPS.has(word)) toks.push({ t: 'op', value: word, pos: i })
      else toks.push({ t: 'ident', value: word, pos: i })
      i = j; continue
    }

    const sym = SYMBOL_OPS.find((o) => src.startsWith(o, i))
    if (sym) { toks.push({ t: 'op', value: sym, pos: i }); i += sym.length; continue }

    throw new ParseError(`非法字符 '${c}'`, i)
  }
  toks.push({ t: 'eof', pos: i })
  return toks
}

// ── 语法 ──────────────────────────────────────────────────────────────────
// expr    := orExpr
// orExpr  := andExpr ('or' andExpr)*
// andExpr := notExpr ('and' notExpr)*
// notExpr := 'not' notExpr | primary
// primary := '(' expr ')' | atom
// atom    := IDENT op literal
// 解析上限：把「栈溢出崩溃」变成「干净的 ParseError」。
// 校验器要吃别人手写的声明（"拷贝大佬的"路径），一份超深嵌套的表达式
// 不该把工具打崩——那既不安全也不可诊断。
// 这组上限同时界定了 AST 深度，因此 evalNode / walk 的递归同样安全。
const LIMITS = { maxLength: 8192, maxDepth: 128, maxAtoms: 256 }

function parse (src) {
  if (typeof src !== 'string') throw new ParseError('表达式必须是字符串', 0)
  if (src.length > LIMITS.maxLength) {
    throw new ParseError(`表达式过长（${src.length} 字符，上限 ${LIMITS.maxLength}）`, LIMITS.maxLength)
  }
  const toks = tokenize(src)
  let p = 0
  let depth = 0
  let atoms = 0
  const enter = (pos) => {
    if (++depth > LIMITS.maxDepth) throw new ParseError(`嵌套过深（上限 ${LIMITS.maxDepth}）`, pos)
  }
  const leave = () => { depth-- }
  const peek = () => toks[p]
  const eat = (t, v) => {
    const tk = toks[p]
    if (tk.t !== t || (v !== undefined && tk.value !== v)) {
      throw new ParseError(`期望 ${v === undefined ? t : v}，实际是 ${tk.value === undefined ? tk.t : tk.value}`, tk.pos)
    }
    p++
    return tk
  }

  const parseOr = () => {
    let left = parseAnd()
    while (peek().t === 'kw' && peek().value === 'or') { p++; left = { kind: 'binary', op: 'or', left, right: parseAnd() } }
    return left
  }
  const parseAnd = () => {
    let left = parseNot()
    while (peek().t === 'kw' && peek().value === 'and') { p++; left = { kind: 'binary', op: 'and', left, right: parseNot() } }
    return left
  }
  const parseNot = () => {
    if (peek().t === 'kw' && peek().value === 'not') {
      enter(peek().pos); p++
      const e = parseNot()
      leave()
      return { kind: 'not', expr: e }
    }
    return parsePrimary()
  }
  const parsePrimary = () => {
    if (peek().t === 'lparen') {
      enter(peek().pos); p++
      const e = parseOr()
      eat('rparen')
      leave()
      return e
    }
    return parseAtom()
  }
  const parseLiteral = () => {
    const tk = peek()
    if (tk.t === 'number') { p++; return { type: 'number', value: tk.value } }
    if (tk.t === 'string') { p++; return { type: 'string', value: tk.value } }
    if (tk.t === 'bool') { p++; return { type: 'bool', value: tk.value } }
    if (tk.t === 'lbracket') {
      p++
      const items = []
      if (peek().t !== 'rbracket') {
        items.push(parseLiteral())
        while (peek().t === 'comma') { p++; items.push(parseLiteral()) }
      }
      eat('rbracket')
      return { type: 'array', value: items }
    }
    throw new ParseError('期望字面量', tk.pos)
  }
  const parseAtom = () => {
    if (++atoms > LIMITS.maxAtoms) throw new ParseError(`条件项过多（上限 ${LIMITS.maxAtoms}）`, peek().pos)
    const id = eat('ident')
    if (peek().t === 'op') {
      const op = toks[p++].value
      return { kind: 'atom', ident: id.value, op, literal: parseLiteral() }
    }
    // 裸布尔字段：`signal.need_docx` 等价于 `signal.need_docx == true`
    return { kind: 'atom', ident: id.value, op: null, literal: null }
  }

  const ast = parseOr()
  if (peek().t !== 'eof') throw new ParseError('表达式末尾有多余内容', peek().pos)
  return ast
}

// ── 分析 ──────────────────────────────────────────────────────────────────
function atomsOf (ast) {
  const out = []
  const walk = (n) => {
    if (n.kind === 'binary') { walk(n.left); walk(n.right) } else if (n.kind === 'not') walk(n.expr)
    else out.push(n)
  }
  walk(ast)
  return out
}

function namespacesOf (ast) {
  const s = new Set()
  for (const a of atomsOf(ast)) s.add(a.ident.split('.')[0])
  return s
}

function signalFieldsOf (ast) {
  const s = new Set()
  for (const a of atomsOf(ast)) {
    const [ns, f] = a.ident.split('.')
    if (ns === 'signal' && f !== undefined) s.add(f)
  }
  return s
}

/** 变量名是否合法：必须是 <ns>.<field> 且 ns 在允许集合内 */
function badIdentsOf (ast, allowed) {
  const bad = []
  for (const a of atomsOf(ast)) {
    const parts = a.ident.split('.')
    if (parts.length !== 2 || !allowed.includes(parts[0])) bad.push(a.ident)
  }
  return bad
}

// ── 求值 ──────────────────────────────────────────────────────────────────
function lookup (ident, env) {
  const parts = ident.split('.')
  if (parts.length !== 2) throw new EvalFail(`非法变量名 ${ident}`)
  const [ns, f] = parts
  if (!env || !(ns in env) || env[ns] === null || env[ns] === undefined || !(f in env[ns])) {
    throw new EvalFail(`字段未定义 ${ident}`)
  }
  return env[ns][f]
}

function evalNode (ast, env) {
  if (ast.kind === 'binary') {
    if (ast.op === 'and') return evalNode(ast.left, env) ? evalNode(ast.right, env) : false
    return evalNode(ast.left, env) ? true : evalNode(ast.right, env)
  }
  if (ast.kind === 'not') return !evalNode(ast.expr, env)

  const v = lookup(ast.ident, env)

  // 裸布尔字段
  if (ast.op === null) {
    if (typeof v !== 'boolean') throw new EvalFail(`${ast.ident} 不是布尔值，不能单独作为条件`)
    return v
  }

  const lit = ast.literal
  const litVal = lit.type === 'array' ? lit.value.map((x) => x.value) : lit.value

  switch (ast.op) {
    case '==':
    case '!=': {
      if (Array.isArray(v) || Array.isArray(litVal)) throw new EvalFail('== / != 不支持数组')
      if (typeof v !== typeof litVal) throw new EvalFail(`类型不匹配：${typeof v} vs ${typeof litVal}`)
      return ast.op === '==' ? v === litVal : v !== litVal
    }
    case 'in': {
      if (lit.type !== 'array') throw new EvalFail('in 右侧必须是数组')
      return litVal.includes(v)
    }
    case '>':
    case '<': {
      if (typeof v !== 'number' || typeof litVal !== 'number') throw new EvalFail('> / < 两侧必须是数字')
      return ast.op === '>' ? v > litVal : v < litVal
    }
    case 'startsWith': {
      if (typeof v !== 'string' || typeof litVal !== 'string') throw new EvalFail('startsWith 两侧必须是字符串')
      return v.startsWith(litVal)
    }
    default:
      throw new EvalFail(`未知运算符 ${ast.op}`)
  }
}

/** 求值失败返回 ok:false —— 调用方据此走 else 边（不是校验错误） */
function evaluate (ast, env) {
  try {
    return { ok: true, value: Boolean(evalNode(ast, env)) }
  } catch (e) {
    if (e instanceof EvalFail) return { ok: false, reason: e.message }
    throw e
  }
}

module.exports = {
  ParseError, EvalFail, LIMITS,
  tokenize, parse, evaluate,
  atomsOf, namespacesOf, signalFieldsOf, badIdentsOf,
}
