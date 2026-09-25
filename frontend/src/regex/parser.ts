import type { ASTNode } from '../types'

/**
 * 统一语法树（内部表示）。
 *
 * 正则只在这一个文件里被读取一次：NFA 构建、对外 AST 投影、
 * 分组编号都基于同一份 ParseResult，避免多处各自遍历造成口径漂移。
 */

/** 量词在源码中的原始写法（花括号量词在 NFA 里有历史行为，需要保留区分） */
export type QuantifierOp = '*' | '+' | '?' | '{}'

export interface ParseResult {
  /** 语法树根节点 */
  root: RegexNode
  /** 捕获分组数量（按左括号出现顺序编号） */
  captureCount: number
}

type RegexNodeType =
  | 'char'
  | 'dot'
  | 'digit'
  | 'word'
  | 'space'
  | 'charclass'
  | 'anchor'
  | 'group'
  | 'star'
  | 'plus'
  | 'question'
  | 'brace'
  | 'concat'
  | 'or'

export interface RegexNode {
  type: RegexNodeType
  /** char: 字面量字符；anchor: ^ 或 $；charclass: 方括号内部原始文本 */
  value?: string
  children?: RegexNode[]
  /** 仅 group：捕获分组序号（从 1 开始）；非捕获组为 undefined */
  groupIndex?: number
  /** 仅 group：是否为捕获组 */
  capturing?: boolean
  /** 仅 star/plus/question/brace：源码中的量词写法 */
  op?: QuantifierOp
  /** 仅 charclass：是否取反 */
  negative?: boolean
  /** 仅 charclass：匹配器需要用到的区间/散字符，NFA 构建时消费 */
  ranges?: [string, string][]
  chars?: string[]
}

/**
 * 唯一的正则遍历入口。
 * 同时负责字符类内部结构解析（NFA 构建阶段直接复用 ranges/chars，
 * 不再重新扫描方括号文本）。
 */
export function parseRegex(pattern: string): ParseResult {
  let pos = 0
  let groupCount = 0

  /** 解析字符类内部结构，填充 node 上的 ranges/chars/value/negative */
  function parseCharClassBody(node: RegexNode, bodyStart: number) {
    const negative = pattern[pos] === '^'
    if (negative) pos++
    const ranges: [string, string][] = []
    const chars: string[] = []
    while (pos < pattern.length && pattern[pos] !== ']') {
      if (pattern[pos + 1] === '-' && pattern[pos + 2] && pattern[pos + 2] !== ']') {
        ranges.push([pattern[pos], pattern[pos + 2]])
        pos += 3
      } else {
        chars.push(pattern[pos])
        pos++
      }
    }
    pos++ // skip ]（未闭合时 pattern[pos] 为 undefined，行为同旧实现）
    node.negative = negative
    node.ranges = ranges
    node.chars = chars
    // 对外 AST 的 charclass.value 只取方括号内原始文本（不含 '['，含可能的 '^'）
    node.value = pattern.slice(bodyStart, pos - 1)
  }

  function parseAtom(): RegexNode {
    const ch = pattern[pos]
    if (ch === '(') {
      pos++
      let capturing = true
      if (pattern[pos] === '?') {
        pos++
        if (pattern[pos] === ':') pos++
        capturing = false
      }
      let groupIndex: number | undefined
      if (capturing) {
        groupCount++
        groupIndex = groupCount
      }
      const child = parseOr()
      pos++ // skip )（未闭合时跳过 undefined，行为同旧实现）
      return { type: 'group', children: [child], capturing, groupIndex }
    }
    if (ch === '[') {
      pos++
      const bodyStart = pos
      const node: RegexNode = { type: 'charclass' }
      parseCharClassBody(node, bodyStart)
      return node
    }
    if (ch === '.') {
      pos++
      return { type: 'dot' }
    }
    if (ch === '\\') {
      pos++
      const escaped = pattern[pos] // 末尾反斜杠时为 undefined，交由 NFA 阶段抛出与旧实现一致的错误
      pos++
      if (escaped === 'd') return { type: 'digit' }
      if (escaped === 'w') return { type: 'word' }
      if (escaped === 's') return { type: 'space' }
      return { type: 'char', value: escaped }
    }
    if (ch === '^' || ch === '$') {
      pos++
      return { type: 'anchor', value: ch }
    }
    pos++
    return { type: 'char', value: ch }
  }

  function parseQuantified(): RegexNode {
    let node = parseAtom()
    while (pos < pattern.length && ['*', '+', '?', '{'].includes(pattern[pos])) {
      const q = pattern[pos]
      let op: QuantifierOp
      if (q === '{') {
        while (pos < pattern.length && pattern[pos] !== '}') pos++
        pos++
        op = '{}'
      } else {
        pos++
        op = q as QuantifierOp
      }
      const type = op === '*' ? 'star' : op === '+' ? 'plus' : op === '?' ? 'question' : 'brace'
      node = { type, op, children: [node] }
      // 每次迭代末尾都预读惰性 '?'（历史行为，NFA 与旧 AST 共用此口径）：
      // 例如 '?+*' 中 '+' 之后的 '*' 会在此被吃掉，链上只构建 '+'
      if (pos < pattern.length && pattern[pos] === '?') pos++
    }
    return node
  }

  function parseConcat(): RegexNode {
    const nodes: RegexNode[] = []
    while (pos < pattern.length && !['|', ')'].includes(pattern[pos])) {
      nodes.push(parseQuantified())
    }
    // 始终保留 concat 节点（即使只有一个子节点）：NFA 构建依赖每个 concat 包一层起始状态；
    // 对外 AST 的单子节点折叠由投影层负责
    return { type: 'concat', children: nodes }
  }

  function parseOr(): RegexNode {
    let node = parseConcat()
    while (pos < pattern.length && pattern[pos] === '|') {
      pos++
      // 左结合嵌套：a|b|c => or(or(a,b),c)，与旧 AST/构建顺序一致
      const right = parseConcat()
      node = { type: 'or', children: [node, right] }
    }
    return node
  }
  const root = parseOr()
  return { root, captureCount: groupCount }
}

/**
 * 将内部统一树投影为既有 ASTNode 结构。
 * 字段形状、groupIndex 编号语义（含历史上非捕获组沿用计数的行为）保持原样。
 */
export function toAstNode(result: ParseResult): ASTNode {
  let legacyGroupIdx = 0

  function project(node: RegexNode): ASTNode {
    switch (node.type) {
      case 'char':
      case 'anchor':
        return { type: node.type, value: node.value }
      case 'dot':
      case 'digit':
      case 'word':
      case 'space':
        return { type: node.type }
      case 'charclass':
        return { type: 'charclass', value: node.value }
      case 'group': {
        // 与旧 parseAST 完全一致：仅捕获组推进编号；但非捕获组也带上当前编号
        if (node.capturing) legacyGroupIdx++
        return { type: 'group', children: [project(node.children![0])], groupIndex: legacyGroupIdx }
      }
      case 'star':
      case 'plus':
      case 'question':
        return { type: node.type, children: [project(node.children![0])] }
      case 'brace':
        // 旧 AST 把任意花括号量词映射成 question
        return { type: 'question', children: [project(node.children![0])] }
      case 'concat': {
        // 复刻旧 parseConcat：单子节点直接返回该节点，空子节点仍返回空 concat
        const children = node.children!.map(project)
        if (children.length === 1) return children[0]
        return { type: 'concat', children }
      }
      case 'or':
        return { type: 'or', children: node.children!.map(project) }
    }
  }

  return project(result.root)
}
