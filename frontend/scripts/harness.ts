import { parseAST, TEMPLATES } from '../src/store/regex'
import { parseRegex } from '../src/regex/parser'
import { buildNFA as buildNFAFromTree, computeNFA, runMatch } from '../src/regex/nfa'

function buildNFA(pattern: string) {
  return buildNFAFromTree(parseRegex(pattern))
}

const cases: Array<[string, string[]]> = [
  ['', ['', '   ', '\t\n', 'abc']],
  ['a', ['a', 'b', '', 'aaa', '   ']],
  ['abc', ['abc', 'xabcx', '']],
  ['ab*c', ['ac', 'abc', 'abbbc', 'c']],
  ['ab+c', ['ac', 'abc', 'abbbc']],
  ['ab?c', ['ac', 'abc', 'abbc']],
  ['a*', ['', 'aaa', 'b']],
  ['a+', ['', 'aaa', 'b']],
  ['colou?r', ['color', 'colour', 'colouur']],
  ['a{2,3}', ['a', 'aa', 'aaa', 'aaaa']],
  ['\\d{2,4}', ['1', '12', '12345', 'ab12cd']],
  ['a*?', ['aaa', '']],
  ['a+?b', ['aaab', 'b']],
  ['(ab)+', ['ab', 'abab', '']],
  ['(a)(b)(c)', ['abc', '']],
  ['(?:ab)+', ['abab', '']],
  ['((a)(b))', ['ab']],
  ['a|b', ['a', 'b', 'c', '']],
  ['cat|dog|bird', ['cat', 'dog', 'bird', 'fish']],
  ['(a|b)+c', ['ac', 'bc', 'abc', 'bac', 'c']],
  ['.', ['a', '\n', '']],
  ['a.c', ['abc', 'ac', 'a\nc']],
  ['\\d+', ['abc', '123', 'a1b2']],
  ['\\w+', ['a_b1', '   ']],
  ['\\s+', ['   ', 'abc', '\t\n ']],
  ['[abc]+', ['abc', 'def', 'cab']],
  ['[^0-9]+', ['abc', '123', 'a1']],
  ['[a-z]+', ['hello', 'HELLO', 'abc123']],
  ['[-a]', ['-', 'a', 'b']],
  ['[]', [']']],
  ['[^abc]', ['a', 'd']],
  ['^abc$', ['abc', 'xabc', 'abcx', '']],
  ['^$', ['', 'a', '   ']],
  ['a\\', ['a']],
  ['(', ['a']],
  [')', [')']],
  ['*', ['*', 'a']],
  ['[', [']', 'abc']],
  ['|', ['a', '', 'b']],
  ['a||b', ['', 'a', 'b']],
  ['(a', ['a']],
  ['a)', ['a']],
  ['\\', ['a', '']],
  ['\\\\', ['\\', 'a']],
  ['\\.', ['.', 'a']],
  ['(a)(?:b)(c)', ['abc']],
  ['(?:(a)|(b))', ['a', 'b']],
  ['()', ['', 'a']],
  ['(?=a)', ['a', 'b']],
  ['a^b', ['ab', 'a^b']],
  ['[a-]', ['a', '-', 'b']],
  ['[z-a]', ['z', 'a', 'm']],
  ['(a)(b)(c)(d)(e)', ['abcde']],
  ['a**b', ['aaab', 'b']],
  ['?+*', ['?', '+', '*']],
]

for (const t of TEMPLATES) cases.push([t.pattern, [t.testString]])

function serializable(v: any): any {
  if (v === undefined) return '__UNDEFINED__'
  if (Array.isArray(v)) return v.map(serializable)
  if (v instanceof Map) return { __map: Array.from(v.entries()).map(([k, val]) => [k, serializable(val)]) }
  if (v && typeof v === 'object') {
    const out: any = {}
    for (const k of Object.keys(v)) out[k] = serializable(v[k])
    return out
  }
  return v
}

const results: any[] = []
for (const [pattern, inputs] of cases) {
  const entry: any = { pattern, inputs: [] as any[] }
  try {
    const built = buildNFA(pattern)
    entry.nfa = serializable({
      startState: built.startState,
      acceptStates: built.acceptStates,
      states: built.states.map(s => ({
        id: s.id,
        isAccept: s.isAccept,
        transitions: s.transitions,
        epsilonTransitions: s.epsilonTransitions
      }))
    })
    entry.computed = serializable(computeNFA(built))
    entry.ast = serializable(parseAST(pattern))
    entry.matches = inputs.map(input => {
      try {
        const r = runMatch(built.states, built.startState, input)
        return {
          input: JSON.stringify(input),
          matched: r.matched,
          matchText: r.matchText,
          groups: r.groups,
          backtracks: r.backtracks,
          totalSteps: r.totalSteps,
          steps: r.steps
        }
      } catch (e: any) {
        return { input: JSON.stringify(input), threw: String(e && e.message) }
      }
    })
  } catch (e: any) {
    entry.threw = String(e && e.message)
  }
  results.push(entry)
}

console.log(JSON.stringify(results))
