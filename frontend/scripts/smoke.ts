// 端到端冒烟：直接驱动 store.execute，覆盖空白文本、普通字符/量词/分组、失败解析
import { createPinia, setActivePinia } from 'pinia'
import { useRegexStore, parseAST } from '../src/store/regex'

setActivePinia(createPinia())
const store = useRegexStore()

function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name)
  if (!cond) process.exitCode = 1
}

// 空白测试文本 + 可空匹配
store.setPattern('a*')
store.setTestString('   ')
check('whitespace input stable, no error', store.error === '')
check('whitespace NFA built', store.nfa !== null && store.nfa.states.length > 0)
check('whitespace match empty string', store.matchResult.matched === true && store.matchResult.matchText === '')
check('whitespace steps sane', Array.isArray(store.matchResult.steps))

// 空模式 + 空文本
store.setPattern('')
store.setTestString('')
check('empty pattern/text no error', store.error === '')
check('empty pattern matches', store.matchResult.matched === true)
check('empty pattern AST is empty concat', JSON.stringify(store.ast) === JSON.stringify({ type: 'concat', children: [] }))

// 普通字符 + 量词 + 分组
store.setPattern('(ab)+c?')
store.setTestString('ababc')
check('group/quantifier match', store.matchResult.matched === true && store.matchResult.matchText === 'ababc')
check('AST exposes group', JSON.stringify(parseAST('(ab)+c?')).includes('"groupIndex":1'))

// 失败解析（末尾反斜杠，旧实现抛错）
store.setPattern('a\\')
store.setTestString('a')
check('trailing backslash reports error', store.error !== '')
check('failed parse clears nfa/result/ast', store.nfa === null && store.matchResult === null && store.ast === null)

// 不匹配（失败解析路径的匹配侧）
store.setPattern('[abc]+') // 历史行为：字符类不匹配
store.setTestString('abc')
check('legacy charclass behavior unchanged', store.matchResult.matched === false)

console.log('done')
