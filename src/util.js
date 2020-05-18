const escapeMap = {
  '\0'   : '\\0',
  '\''   : '\\\'',
  '"'    : '\\"',
  '\b'   : '\\b',
  '\n'   : '\\n',
  '\r'   : '\\r',
  '\t'   : '\\t',
  '\x1a' : '\\Z',
  // '\\'   : '\\\\',
}

const DEFAULT_OPT = {
  database : 'mysql',
  type     : 'table',
}

let parserOpt = DEFAULT_OPT

function commonOptionConnector(keyword, action, opt) {
  if (!opt) return
  if (!keyword) return action(opt)
  return `${keyword.toUpperCase()} ${action(opt)}`
}

function connector(keyword, str) {
  if (!str) return
  return `${keyword.toUpperCase()} ${str}`
}

/**
 * @param {(Array|boolean|string|number|null)} value
 * @return {Object}
 */
function createValueExpr(value) {
  const type = typeof value
  if (Array.isArray(value)) return { type: 'expr_list', value: value.map(createValueExpr) }
  if (value === null) return { type: 'null', value: null }
  switch (type) {
    case 'boolean':
      return { type: 'bool', value }
    case 'string':
      return { type: 'string', value }
    case 'number':
      return { type: 'number', value }
    default:
      throw new Error(`Cannot convert value "${type}" to SQL`)
  }
}

/**
 * @param operator
 * @param left
 * @param right
 * @return {Object}
 */
function createBinaryExpr(operator, left, right) {
  const expr = { operator, type: 'binary_expr' }
  expr.left = left.type ? left : createValueExpr(left)
  if (operator === 'BETWEEN' || operator === 'NOT BETWEEN') {
    expr.right = {
      type  : 'expr_list',
      value : [createValueExpr(right[0]), createValueExpr(right[1])],
    }
    return expr
  }
  expr.right = right.type ? right : createValueExpr(right)
  return expr
}

/**
 * Replace param expressions
 *
 * @param {Object} ast    - AST object
 * @param {Object} keys   - Keys = parameter names, values = parameter values
 * @return {Object}     - Newly created AST object
 */
function replaceParamsInner(ast, keys) {
  Object.keys(ast)
    .filter(key => {
      const value = ast[key]
      return Array.isArray(value) || (typeof value === 'object' && value !== null)
    })
    .forEach(key => {
      const expr = ast[key]
      if (!(typeof expr === 'object' && expr.type === 'param')) return replaceParamsInner(expr, keys)
      if (typeof keys[expr.value] === 'undefined') throw new Error(`no value for parameter :${expr.value} found`)
      ast[key] = createValueExpr(keys[expr.value])
      return null
    })

  return ast
}

function escape(str) {
  const res = []
  for (let i = 0, len = str.length; i < len; ++i) {
    let char = str[i]
    const escaped = escapeMap[char]
    if (escaped) char = escaped
    res.push(char)
  }
  return res.join('')
}

function getParserOpt() {
  return parserOpt
}

function setParserOpt(opt) {
  parserOpt = opt
}

function topToSQL(opt) {
  if (!opt) return
  const { value, percent } = opt
  const prefix = `TOP ${value}`
  if (!percent) return prefix
  return `${prefix} ${percent.toUpperCase()}`
}

function identifierToSql(ident, isDual) {
  const { database } = getParserOpt()
  if (isDual === true) return `'${ident}'`
  if (!ident) return
  switch (database && database.toLowerCase()) {
    case 'mysql':
    case 'mariadb':
      return `\`${ident}\``
    case 'postgresql':
      return `"${ident}"`
    case 'transactsql':
      return `[${ident}]`
    case 'bigquery':
      return ident
    default:
      return `\`${ident}\``
  }
}

function literalToSQL(literal) {
  const { type, parentheses, value } = literal
  let str = value
  switch (type) {
    case 'string':
      str = `'${escape(value)}'`
      break
    case 'single_quote_string':
      str = `'${value}'`
      break
    case 'boolean':
    case 'bool':
      str = value ? 'TRUE' : 'FALSE'
      break
    case 'null':
      str = 'NULL'
      break
    case 'star':
      str = '*'
      break
    case 'param':
      str = `:${value}`
      break
    case 'origin':
      str = value.toUpperCase()
      break
    case 'time':
    case 'date':
    case 'timestamp':
      str = `${type.toUpperCase()} '${value}'`
      break
    default:
      break
  }
  return parentheses ? `(${str})` : str
}

function replaceParams(ast, params) {
  return replaceParamsInner(JSON.parse(JSON.stringify(ast)), params)
}

function commonTypeValue(opt) {
  const result = []
  if (!opt) return result
  const { type, value } = opt
  result.push(type.toUpperCase())
  result.push(value.toUpperCase())
  return result
}

function columnRefToSQL(expr) {
  const {
    arrow,
    collate,
    column,
    isDual,
    table,
    parentheses,
    property,
  } = expr
  let str = column === '*' ? '*' : identifierToSql(column, isDual)
  if (table) str = `${identifierToSql(table)}.${str}`
  if (arrow) str += ` ${arrow} ${literalToSQL(property)}`
  if (collate) str += ` ${commonTypeValue(collate).join(' ')}`
  return parentheses ? `(${str})` : str
}

function toUpper(val) {
  if (!val) return
  return val.toUpperCase()
}

function hasVal(val) {
  return val
}

function arrayStructTypeToSQL(expr) {
  if (!expr) return
  const { dataType, definition, anglebracket } = expr
  const dataTypeUpper = toUpper(dataType)
  const isNotArrayOrStruct = dataTypeUpper !== 'ARRAY' && dataTypeUpper !== 'STRUCT'
  if (isNotArrayOrStruct) return dataTypeUpper
  const result = definition && definition.map(field => {
    const {
      field_name: fieldName, field_type: fieldType,
    } = field
    const fieldResult = [fieldName, arrayStructTypeToSQL(fieldType)]
    return fieldResult.filter(hasVal).join(' ')
  }).join(', ')
  return anglebracket ? `${dataTypeUpper}<${result}>` : `${dataTypeUpper} ${result}`
}

function commentToSQL(comment) {
  if (!comment) return
  const result = []
  const { keyword, symbol, value } = comment
  result.push(keyword.toUpperCase())
  if (symbol) result.push(symbol)
  result.push(literalToSQL(value))
  return result.join(' ')
}

function triggerEventToSQL(events) {
  return events.map(event => {
    const { keyword: kw, args } = event
    const result = [toUpper(kw)]
    if (args) {
      const { keyword: kwArgs, columns } = args
      result.push(toUpper(kwArgs), columns.map(columnRefToSQL).join(', '))
    }
    return result.join(' ')
  }).join(' OR ')
}

function returningToSQL(returning) {
  if (!returning) return ''
  const { columns } = returning
  return ['RETURNING', columns.map(columnRefToSQL).filter(hasVal).join(', ')].join(' ')
}

function commonKeywordArgsToSQL(kwArgs) {
  if (!kwArgs) return []
  return [toUpper(kwArgs.keyword), toUpper(kwArgs.args)]
}

function autoIncreatementToSQL(autoIncreatement) {
  if (!autoIncreatement || typeof autoIncreatement === 'string') return toUpper(autoIncreatement)
  const { keyword, seed, increment, parentheses } = autoIncreatement
  let result = toUpper(keyword)
  if (parentheses) result += `(${literalToSQL(seed)}, ${literalToSQL(increment)})`
  return result
}

export {
  arrayStructTypeToSQL, autoIncreatementToSQL,
  commonKeywordArgsToSQL, commonOptionConnector,
  connector, commonTypeValue, columnRefToSQL,
  commentToSQL, createBinaryExpr, createValueExpr,
  DEFAULT_OPT, escape, literalToSQL, identifierToSql,
  replaceParams, returningToSQL, hasVal, setParserOpt,
  toUpper, topToSQL, triggerEventToSQL,
}
