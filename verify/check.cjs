// ACT 设计验证夹具 —— 不是阶段 0 的正式校验器。
// 目的：证明 act.schema.json 可用、且关键的 CSP_AMZ 约束真的会拦人。
// 用法：node check.cjs <schema.json> <fixture.json>
'use strict'

const fs = require('fs')

function loadAjv () {
  const bases = [
    process.cwd(),
    'C:/Users/L2959/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh',
    'C:/Users/L2959/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules'
  ]
  for (const b of bases) {
    try {
      const resolved = require.resolve('ajv/dist/2020', { paths: [b] })
      const mod = require(resolved)
      return mod.default || mod
    } catch (_) { /* try next */ }
  }
  throw new Error('ajv/dist/2020 未找到')
}

const Ajv2020 = loadAjv()
const [schemaPath, fixturePath] = process.argv.slice(2)
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))

const ajv = new Ajv2020({ allErrors: true, strict: false })
const validate = ajv.compile(schema)
const ok = validate(fixture)

console.log(`${ok ? 'VALID  ' : 'INVALID'}  ${fixturePath}`)
if (!ok) {
  for (const e of validate.errors) {
    console.log(`   ${e.instancePath || '/'} ${e.message}`)
    if (e.params && Object.keys(e.params).length) {
      console.log(`      params: ${JSON.stringify(e.params)}`)
    }
  }
}
process.exitCode = ok ? 0 : 1
