/**
 * parser.js
 * lexer.js-dən gələn tokenləri təmiz AST (Abstract Syntax Tree) node-larına çevirir.
 * - @CTX-də bilinən dəyişənləri parse zamanı birbaşa əvəz edir (statik substitution).
 * - !EXEC nəticələri kimi runtime-da məlum olan dəyişənlər üçün "var" node saxlanır,
 *   bu isə executor.js tərəfindən icra zamanı həll edilir.
 * - Bir sətirdə xəta olarsa, o sətir ERROR node kimi qeyd olunur və proses davam edir
 *   (bütün skript çökmür).
 */

import { tokenizeLine, normalizeKeyword } from './lexer.js';

// ---------- Köməkçi funksiyalar ----------

function stripQuotes(str) {
  const s = str.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function coerceLiteral(raw) {
  const s = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  return stripQuotes(s);
}

/**
 * `$user.status` və ya `$userId` kimi ifadələri, ya da adi literal dəyərləri
 * dəyər node-una çevirir. Əgər dəyişən adı knownCtx-də (parse-time məlum olan
 * @CTX dəyərləri) mövcuddursa, birbaşa əvəz olunur (literal). Əks halda,
 * runtime-da (executor) həll ediləcək "var" node qaytarılır.
 */
function resolveValueExpr(raw, knownCtx) {
  const s = raw.trim();

  if (s.startsWith('$')) {
    const path = s.slice(1);
    const rootKey = path.split('.')[0];

    if (!path.includes('.') && Object.prototype.hasOwnProperty.call(knownCtx, rootKey)) {
      // Parse-time-da bilinən sadə dəyişən -> birbaşa əvəz et (literal)
      return { kind: 'literal', value: knownCtx[rootKey], substitutedFrom: s };
    }
    // Runtime-da (məs. !EXEC nəticəsi) məlum olacaq -> var reference saxla
    return { kind: 'var', path };
  }

  return { kind: 'literal', value: coerceLiteral(s) };
}

/**
 * Dırnaqlar daxilindəki vergülləri nəzərə alaraq parametr sətrini ayırır.
 * Məsələn: `id=$userId, name="Ali, Vali"` -> ["id=$userId", 'name="Ali, Vali"']
 */
function splitRespectingQuotes(str) {
  const parts = [];
  let current = '';
  let inQuote = null;

  for (const ch of str) {
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
    } else if (ch === ',') {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

function parseParams(paramsStr, knownCtx) {
  const trimmed = paramsStr.trim();
  if (trimmed === '') return [];

  return splitRespectingQuotes(trimmed).map((chunk) => {
    const eqIdx = chunk.indexOf('=');
    if (eqIdx === -1) {
      throw new Error(`Parametr "${chunk.trim()}" düzgün formatda deyil (key=value gözlənilir)`);
    }
    const key = chunk.slice(0, eqIdx).trim();
    const valueRaw = chunk.slice(eqIdx + 1).trim();
    return { key, value: resolveValueExpr(valueRaw, knownCtx) };
  });
}

// ---------- Sətir tiplərinə görə parse funksiyaları ----------

function parseGoal(token) {
  return { type: 'GOAL', text: token.content, line: token.line };
}

function parseCtx(token, knownCtx) {
  const eqIdx = token.content.indexOf('=');
  if (eqIdx === -1) {
    throw new Error(`@CTX sətri "key=value" formatında olmalıdır: "${token.content}"`);
  }
  const key = token.content.slice(0, eqIdx).trim();
  const valueRaw = token.content.slice(eqIdx + 1).trim();
  if (!key) throw new Error('@CTX açarı boş ola bilməz');

  const value = coerceLiteral(valueRaw);
  knownCtx[key] = value; // parse-time bilgi bazasını yenilə
  return { type: 'CTX', key, value, line: token.line };
}

function parseExec(token, knownCtx) {
  // Format: toolName(param=value, ...) :: $outputVar
  const parts = token.content.split('::');
  const callPart = parts[0].trim();
  const outputPart = parts.length > 1 ? parts[1].trim() : null;

  const callMatch = callPart.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*$/s);
  if (!callMatch) {
    throw new Error(`!EXEC çağırışı tanınmadı: "${callPart}" (gözlənilən format: toolName(param=value) :: $out)`);
  }

  const toolName = callMatch[1];
  const params = parseParams(callMatch[2], knownCtx);

  let outputVar = null;
  if (outputPart) {
    if (!outputPart.startsWith('$')) {
      throw new Error(`!EXEC çıxış dəyişəni "$" ilə başlamalıdır: "${outputPart}"`);
    }
    outputVar = outputPart.slice(1).trim();
  }

  return { type: 'EXEC', tool: toolName, params, output: outputVar, line: token.line };
}

function parseEmit(token, knownCtx) {
  const value = resolveValueExpr(token.content, knownCtx);
  return { type: 'EMIT', value, line: token.line };
}

const OPERATORS = ['==', '!=', '>=', '<=', '>', '<', 'contains'];

/**
 * Şərt mətnini (`&&` / `||` daxil ola bilər) dırnaqları nəzərə alaraq
 * "clause" (tək müqayisə) və "op" (`&&`/`||`) tokenlərinə bölür.
 * Misal: `$a == 1 && $b == 2 || $c == 3`
 *   -> [clause:"$a == 1", op:"&&", clause:"$b == 2", op:"||", clause:"$c == 3"]
 */
function tokenizeLogical(str) {
  const tokens = [];
  let current = '';
  let inQuote = null;
  let i = 0;

  while (i < str.length) {
    const ch = str[i];

    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      i++;
      continue;
    }

    if (str.slice(i, i + 2) === '&&') {
      tokens.push({ type: 'clause', text: current.trim() });
      tokens.push({ type: 'op', value: '&&' });
      current = '';
      i += 2;
      continue;
    }

    if (str.slice(i, i + 2) === '||') {
      tokens.push({ type: 'clause', text: current.trim() });
      tokens.push({ type: 'op', value: '||' });
      current = '';
      i += 2;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.trim() !== '') tokens.push({ type: 'clause', text: current.trim() });
  return tokens;
}

/**
 * Tək bir müqayisə ifadəsini (`$a == "b"` kimi) COMPARISON node-una çevirir.
 */
function parseComparisonClause(conditionPart, knownCtx) {
  let operator = null;
  let opIdx = -1;

  // Operatoru tap (uzun operatorlar əvvəl yoxlanır ki, "==" içindəki "=" səhv tutulmasın)
  for (const op of OPERATORS) {
    const idx = conditionPart.indexOf(` ${op} `);
    if (idx !== -1 && (opIdx === -1 || idx < opIdx)) {
      operator = op;
      opIdx = idx;
    }
  }
  if (!operator) {
    throw new Error(`? şərtində tanınan operator tapılmadı (==, !=, >, <, contains): "${conditionPart}"`);
  }

  const leftRaw = conditionPart.slice(0, opIdx).trim();
  const rightRaw = conditionPart.slice(opIdx + operator.length + 2).trim();

  const left = resolveValueExpr(leftRaw, knownCtx);
  const right = resolveValueExpr(rightRaw, knownCtx);

  return { type: 'COMPARISON', left, operator, right, raw: conditionPart };
}

/**
 * `&&` (yüksək prioritet) və `||` (aşağı prioritet) operatorlarını dəstəkləyən
 * recursive-descent parser. Mötərizə (parentez) dəstəklənmir — soldan sağa,
 * standart məntiqi prioritet qaydasına (AND > OR) əsasən qiymətləndirilir.
 *
 *   parseOr  := parseAnd ( '||' parseAnd )*
 *   parseAnd := clause   ( '&&' clause   )*
 */
function parseLogicalCondition(str, knownCtx) {
  const tokens = tokenizeLogical(str);
  if (tokens.length === 0) {
    throw new Error(`Şərt ifadəsi boşdur: "${str}"`);
  }

  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  function parseClauseToken() {
    const tok = consume();
    if (!tok || tok.type !== 'clause' || tok.text === '') {
      throw new Error(`Şərt ifadəsi düzgün formatda deyil (operator ardınca ifadə gözlənilir): "${str}"`);
    }
    return parseComparisonClause(tok.text, knownCtx);
  }

  function parseAndExpr() {
    let node = parseClauseToken();
    while (peek() && peek().type === 'op' && peek().value === '&&') {
      consume();
      const right = parseClauseToken();
      node = { type: 'LOGICAL', operator: '&&', left: node, right };
    }
    return node;
  }

  function parseOrExpr() {
    let node = parseAndExpr();
    while (peek() && peek().type === 'op' && peek().value === '||') {
      consume();
      const right = parseAndExpr();
      node = { type: 'LOGICAL', operator: '||', left: node, right };
    }
    return node;
  }

  const result = parseOrExpr();
  if (pos !== tokens.length) {
    throw new Error(`Şərt ifadəsində gözlənilməyən artıq hissə var: "${str}"`);
  }
  return result;
}

function parseCond(token, knownCtx) {
  const content = token.content;
  const arrowIdx = content.indexOf('->');
  if (arrowIdx === -1) {
    throw new Error(`? şərt sətrində "->" tapılmadı: "${content}"`);
  }

  const conditionPart = content.slice(0, arrowIdx).trim();
  const actionPart = content.slice(arrowIdx + 2).trim();

  if (!conditionPart) {
    throw new Error('? şərtinin "->" öncəsi şərt ifadəsi boşdur');
  }
  if (!actionPart) {
    throw new Error('? şərtinin "->" sonrası Əməl (Action) hissəsi boşdur');
  }

  const condition = parseLogicalCondition(conditionPart, knownCtx);

  // Action hissəsini əsas lexer/parser məntiqi ilə (nested) parse et
  const actionToken = tokenizeLine(actionPart, token.line);
  const action = parseSingleToken(actionToken, knownCtx);

  return { type: 'COND', condition, action, line: token.line };
}

/**
 * Bir tokeni AST node-una çevirir. Həm əsas dövr, həm də COND-un daxili
 * Action hissəsi üçün paylaşılan giriş nöqtəsi.
 */
function parseSingleToken(token, knownCtx) {
  switch (token.type) {
    case 'GOAL':
      return parseGoal(token);
    case 'CTX':
      return parseCtx(token, knownCtx);
    case 'EXEC':
      return parseExec(token, knownCtx);
    case 'EMIT':
      return parseEmit(token, knownCtx);
    case 'COND':
      return parseCond(token, knownCtx);
    case 'UNKNOWN':
      throw new Error(token.reason || 'Tanınmayan sətir');
    default:
      throw new Error(`Dəstəklənməyən token tipi: ${token.type}`);
  }
}

/**
 * Əsas giriş nöqtəsi: tokenlər massivini AST-yə çevirir.
 * @returns {{ ast: object[], errors: {line:number, message:string, raw:string}[] }}
 */
export function parse(tokens) {
  const ast = [];
  const errors = [];
  const knownCtx = {}; // parse-time məlum @CTX dəyərləri

  for (const token of tokens) {
    try {
      const node = parseSingleToken(token, knownCtx);
      ast.push(node);
    } catch (err) {
      errors.push({ line: token.line, message: err.message, raw: token.raw });
      ast.push({ type: 'ERROR', line: token.line, message: err.message, raw: token.raw });
    }
  }

  return { ast, errors };
}

export default { parse };
