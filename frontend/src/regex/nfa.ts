import type { NFA } from '../types'
import type { ParseResult, RegexNode } from './parser'

interface StateNode {
  id: number
  isAccept: boolean
  transitions: Map<string, number[]>
  epsilonTransitions: number[]
  /** 字符类匹配器（历史上挂在片段结束状态上） */
  _matcher?: (ch: string) => boolean
}

/**
 * 基于统一语法树构建 Thompson NFA。
 * 这里不再扫描正则源码，所有节点/量词/分组信息都来自 parser 的唯一一次遍历，
 * 与对外 AST、分组编号读取的是同一份结果。
 */
export function buildNFA(result: ParseResult): { states: StateNode[]; startState: number; acceptStates: number[] } {
  const states: StateNode[] = []
  let stateCounter = 0

  function newState(): number {
    const id = stateCounter++
    states.push({ id, isAccept: false, transitions: new Map(), epsilonTransitions: [] })
    return id
  }

  function addTransition(from: number, symbol: string, to: number) {
    if (!states[from].transitions.has(symbol)) {
      states[from].transitions.set(symbol, [])
    }
    states[from].transitions.get(symbol)!.push(to)
  }

  function addEpsilon(from: number, to: number) {
    states[from].epsilonTransitions.push(to)
  }

  /** 字符类匹配逻辑只有这一处实现，NFA 执行阶段直接复用 */
  function makeMatcher(node: RegexNode): (ch: string) => boolean {
    const negative = !!node.negative
    const ranges = node.ranges!
    const chars = node.chars!
    return (ch: string) => {
      if (negative) {
        return !chars.includes(ch) && !ranges.some(([s, e]) => ch >= s && ch <= e)
      }
      return chars.includes(ch) || ranges.some(([s, e]) => ch >= s && ch <= e)
    }
  }

  /** 构建一个「原子 + 量词链」片段，返回 [入口状态, 出口状态] */
  function buildQuantified(node: RegexNode): [number, number] {
    // 与旧实现逐字符扫描同序：先建原子；随后从内向外，每遇到一层量词就
    // 立刻建 qStart/qEnd 并完成该层全部 ε 边（状态分配与边插入交错进行）
    const wrappers: RegexNode[] = []
    let inner = node
    while (inner.type === 'star' || inner.type === 'plus' || inner.type === 'question' || inner.type === 'brace') {
      wrappers.push(inner)
      inner = inner.children![0]
    }
    // wrappers 按外层→内层排列（先扫到的外层量词在前）；
    // 旧实现是边解析边包裹，内层片段先形成，因此这里从最内层向外依次包裹
    let [segStart, segEnd] = buildAtom(inner)

    for (let i = wrappers.length - 1; i >= 0; i--) {
      const q = wrappers[i]
      const qStart = newState()
      const qEnd = newState()
      addEpsilon(qStart, segStart)
      if (q.op === '*') {
        addEpsilon(qStart, qEnd)
        addEpsilon(segEnd, qEnd)
        addEpsilon(segEnd, segStart)
      } else if (q.op === '+') {
        addEpsilon(segEnd, qEnd)
        addEpsilon(segEnd, segStart)
      } else if (q.op === '?') {
        addEpsilon(qStart, qEnd)
        addEpsilon(segEnd, qEnd)
      }
      // 花括号量词：历史上只有 qStart -> segStart 一条边，保持该现状
      segStart = qStart
      segEnd = qEnd
    }
    return [segStart, segEnd]
  }

  function buildAtom(node: RegexNode): [number, number] {
    switch (node.type) {
      case 'group':
        // 括号本身不产生状态，捕获信息由 parser 统一编号；
        // 子节点是 parseOr 的直接结果（or 或 concat），统一走 buildNode
        return buildNode(node.children![0])
      case 'charclass': {
        const segStart = newState()
        const segEnd = newState()
        addTransition(segStart, '__class_' + segStart, segEnd)
        states[segEnd]._matcher = makeMatcher(node)
        return [segStart, segEnd]
      }
      case 'dot': {
        const segStart = newState()
        const segEnd = newState()
        addTransition(segStart, '__dot', segEnd)
        return [segStart, segEnd]
      }
      case 'digit':
      case 'word':
      case 'space': {
        const segStart = newState()
        const segEnd = newState()
        addTransition(segStart, '__' + node.type, segEnd)
        return [segStart, segEnd]
      }
      case 'anchor': {
        // 锚点是零宽片段：入口与出口为同一状态
        const state = newState()
        return [state, state]
      }
      case 'char': {
        const segStart = newState()
        const segEnd = newState()
        // value 为 undefined 时（如末尾反斜杠），下游 computeNFA 会抛出与旧实现一致的错误
        addTransition(segStart, node.value as string, segEnd)
        return [segStart, segEnd]
      }
      default:
        // concat/or 仅可能出现在 group/or 的子节点中，经由它们的构建函数处理
        return buildNode(node)
    }
  }

  function buildConcat(node: RegexNode): [number, number] {
    // 每个 concat 固定先建一个起始状态（单子节点也一样），与旧实现同序
    const start = newState()
    let end = start
    for (const child of node.children!) {
      const [segStart, segEnd] = buildQuantified(child)
      if (end !== segStart) addEpsilon(end, segStart)
      end = segEnd
    }
    return [start, end]
  }

  function buildOr(node: RegexNode): [number, number] {
    // parser 产出左结合二叉 or：a|b|c => or(or(a,b),c)
    const left = node.children![0]
    const right = node.children![1]
    const [s1, e1] = left.type === 'or' ? buildOr(left) : buildConcat(left)
    const [s2, e2] = buildConcat(right)
    const ns = newState()
    const ne = newState()
    addEpsilon(ns, s1)
    addEpsilon(ns, s2)
    addEpsilon(e1, ne)
    addEpsilon(e2, ne)
    return [ns, ne]
  }

  function buildNode(node: RegexNode): [number, number] {
    if (node.type === 'or') return buildOr(node)
    if (node.type === 'concat') return buildConcat(node)
    return buildQuantified(node)
  }

  // 根节点可能是 or，也可能直接是 concat（无 '|' 时 parser 原样返回 concat）
  const [startState, acceptState] = buildNode(result.root)
  states[acceptState].isAccept = true
  return { states, startState, acceptStates: [acceptState] }
}

function epsilonClosure(states: StateNode[], stateId: number): Set<number> {
  const closure = new Set<number>([stateId])
  const stack = [stateId]
  while (stack.length) {
    const s = stack.pop()!
    for (const next of states[s].epsilonTransitions) {
      if (!closure.has(next)) {
        closure.add(next)
        stack.push(next)
      }
    }
  }
  return closure
}

function matchTransition(state: StateNode, symbol: string): number[] {
  const results: number[] = []
  for (const [sym, targets] of state.transitions) {
    if (sym === symbol) { results.push(...targets); continue }
    if (sym === '__dot' && symbol !== '\n') { results.push(...targets); continue }
    if (sym === '__digit' && /\d/.test(symbol)) { results.push(...targets); continue }
    if (sym === '__word' && /\w/.test(symbol)) { results.push(...targets); continue }
    if (sym === '__space' && /\s/.test(symbol)) { results.push(...targets); continue }
    if (sym.startsWith('__class_')) {
      const matcher = state._matcher
      if (matcher && matcher(symbol)) results.push(...targets)
    }
  }
  return results
}

export function runMatch(states: StateNode[], startState: number, input: string) {
  const steps: import('../types').MatchStep[] = []
  let backtracks = 0
  let stepIndex = 0
  const startTime = performance.now()

  // Try to match from each position
  for (let startPos = 0; startPos <= input.length; startPos++) {
    let currentStates = Array.from(epsilonClosure(states, startState))
    let matched = false
    let matchEnd = startPos

    for (let i = startPos; i < input.length; i++) {
      const char = input[i]
      const nextStates: number[] = []
      const seen = new Set<number>()

      for (const s of currentStates) {
        const targets = matchTransition(states[s], char)
        for (const t of targets) {
          const closure = epsilonClosure(states, t)
          for (const c of closure) {
            if (!seen.has(c)) {
              seen.add(c)
              nextStates.push(c)
              steps.push({
                stepIndex: stepIndex++,
                charIndex: i,
                char,
                currentState: s,
                nextState: c,
                transition: char,
                isBacktrack: false,
                isMatch: true
              })
            }
          }
        }
      }

      if (nextStates.length === 0) {
        if (currentStates.some(s => states[s].isAccept)) { matched = true; matchEnd = i; break }
        backtracks++
        steps.push({
          stepIndex: stepIndex++,
          charIndex: i,
          char,
          currentState: currentStates[0] || -1,
          nextState: -1,
          transition: 'FAIL',
          isBacktrack: true,
          isMatch: false
        })
        break
      }
      currentStates = nextStates
      if (currentStates.some(s => states[s].isAccept)) { matched = true; matchEnd = i + 1 }
    }

    if (matched || (startPos === input.length && currentStates.some(s => states[s].isAccept))) {
      const matchText = input.substring(startPos, matchEnd)
      const duration = performance.now() - startTime
      return {
        matched: true,
        matchText,
        groups: [matchText],
        steps,
        backtracks,
        totalSteps: stepIndex,
        duration: Math.round(duration * 100) / 100
      }
    }
  }

  const duration = performance.now() - startTime
  return { matched: false, matchText: '', groups: [] as string[], steps, backtracks, totalSteps: stepIndex, duration: Math.round(duration * 100) / 100 }
}

export function computeNFA(nfaResult: ReturnType<typeof buildNFA>): NFA {
  const nodes = nfaResult.states.map((s, i) => ({
    id: s.id,
    isStart: i === nfaResult.startState,
    isAccept: nfaResult.acceptStates.includes(s.id),
    x: 0, y: 0
  }))

  // Layout: circular
  const cx = 400, cy = 300, radius = 200
  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2
    n.x = cx + Math.cos(angle) * radius
    n.y = cy + Math.sin(angle) * radius
  })

  const transitions: NFA['transitions'] = []
  nfaResult.states.forEach(s => {
    s.transitions.forEach((targets, symbol) => {
      targets.forEach(t => {
        transitions.push({ from: s.id, to: t, symbol: symbol.startsWith('__') ? symbol.replace('__', '') : symbol, label: symbol.startsWith('__') ? symbol.replace('__', '') : symbol })
      })
    })
    s.epsilonTransitions.forEach(t => {
      transitions.push({ from: s.id, to: t, symbol: null, label: 'ε' })
    })
  })

  return { states: nodes, transitions, startState: nfaResult.startState, acceptStates: nfaResult.acceptStates }
}
