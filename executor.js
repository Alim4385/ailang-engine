/**
 * executor.js
 * AST-ni sətir-sətir (node-node) asinxron icra edən əsas motor.
 * - ctx (kontekst) obyektini idarə edir: @CTX dəyərləri + !EXEC nəticələri.
 * - ? şərt node-larını runtime-da dinamik yoxlayır.
 * - !EXEC üçün alət (tool) registri saxlayır və çağırır.
 * - Hər addımı executionLog-a yazır (debugging / audit üçün).
 */

// ---------- Nested path köməkçiləri ----------

function getPath(obj, path) {
  if (obj == null) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

// ---------- Default alət (tool) registri ----------
// Real layihədə bunlar həqiqi DB/HTTP çağırışları ilə əvəz oluna bilər.
// Hər alət `async (params, ctx) => any` formasındadır.

export const defaultTools = {
  async checkDatabase(params) {
    // Mock DB nəticəsi. Real mühitdə burada Postgres/Mongo s. sorğu olardı.
    const id = params.id;
    return {
      id,
      status: id != null && Number(id) % 2 === 0 ? 'active' : 'inactive',
      fetchedAt: new Date().toISOString(),
    };
  },

  async fetchProfile(params) {
    return {
      id: params.id,
      name: `İstifadəçi #${params.id}`,
      role: 'member',
    };
  },

  async httpGet(params) {
    if (!params.url) throw new Error('httpGet üçün "url" parametri tələb olunur');
    const res = await fetch(params.url);
    const contentType = res.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await res.json() : await res.text();
    return { statusCode: res.status, body };
  },

  async wait(params) {
    const ms = Number(params.ms) || 0;
    await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5000)));
    return { waited: ms };
  },
};

// ---------- Dəyər node-larının runtime həlli ----------

function resolveValueNode(node, ctx) {
  if (node.kind === 'literal') return node.value;
  if (node.kind === 'var') return getPath(ctx, node.path);
  return undefined;
}

function resolveParams(params, ctx) {
  const resolved = {};
  for (const p of params) {
    resolved[p.key] = resolveValueNode(p.value, ctx);
  }
  return resolved;
}

/**
 * COMPARISON / LOGICAL (&&, ||) ağacını rekursiv qiymətləndirir.
 * Standart qısa-dövrəli (short-circuit) məntiq tətbiq olunur:
 *   && -> sol tərəf false-dursa sağ tərəf hesablanmır
 *   || -> sol tərəf true-dursa sağ tərəf hesablanmır
 * `trace` massivinə hər bir leaf COMPARISON-un nəticəsi debugging üçün yazılır.
 */
function evalCondition(node, ctx, trace) {
  if (node.type === 'COMPARISON') {
    const leftVal = resolveValueNode(node.left, ctx);
    const rightVal = resolveValueNode(node.right, ctx);
    const matched = evalOperator(leftVal, node.operator, rightVal);
    trace.push({ raw: node.raw, left: leftVal, operator: node.operator, right: rightVal, matched });
    return matched;
  }

  if (node.type === 'LOGICAL') {
    if (node.operator === '&&') {
      const leftMatched = evalCondition(node.left, ctx, trace);
      if (!leftMatched) return false; // short-circuit
      return evalCondition(node.right, ctx, trace);
    }
    if (node.operator === '||') {
      const leftMatched = evalCondition(node.left, ctx, trace);
      if (leftMatched) return true; // short-circuit
      return evalCondition(node.right, ctx, trace);
    }
    throw new Error(`Naməlum məntiqi operator: ${node.operator}`);
  }

  throw new Error(`Naməlum şərt node tipi: ${node.type}`);
}

// ---------- Şərt operatorlarının qiymətləndirilməsi ----------

function evalOperator(left, operator, right) {
  switch (operator) {
    case '==':
      // eslint-disable-next-line eqeqeq
      return left == right;
    case '!=':
      // eslint-disable-next-line eqeqeq
      return left != right;
    case '>':
      return Number(left) > Number(right);
    case '<':
      return Number(left) < Number(right);
    case '>=':
      return Number(left) >= Number(right);
    case '<=':
      return Number(left) <= Number(right);
    case 'contains':
      if (Array.isArray(left)) return left.includes(right);
      if (typeof left === 'string') return left.includes(String(right));
      return false;
    default:
      throw new Error(`Naməlum operator: ${operator}`);
  }
}

/**
 * AILang AST-ni icra edir.
 * @param {object[]} ast - parser.parse() nəticəsi olan AST massivi
 * @param {object} options
 * @param {object} [options.ctx] - başlanğıc kontekst (əvvəlcədən ötürülmüş dəyişənlər)
 * @param {object} [options.tools] - əlavə/əvəzedici alətlər { adı: async fn }
 * @returns {Promise<{ ctx: object, emissions: any[], result: any, executionLog: object[], errors: object[] }>}
 */
export async function execute(ast, options = {}) {
  const ctx = { ...(options.ctx || {}) };
  const tools = { ...defaultTools, ...(options.tools || {}) };

  const executionLog = [];
  const emissions = [];
  const errors = [];

  async function runNode(node) {
    switch (node.type) {
      case 'GOAL': {
        executionLog.push({ line: node.line, type: 'GOAL', text: node.text });
        break;
      }

      case 'CTX': {
        ctx[node.key] = node.value;
        executionLog.push({ line: node.line, type: 'CTX', key: node.key, value: node.value });
        break;
      }

      case 'EXEC': {
        const toolFn = tools[node.tool];
        const resolvedParams = resolveParams(node.params, ctx);

        if (typeof toolFn !== 'function') {
          const message = `Naməlum alət (tool): "${node.tool}"`;
          errors.push({ line: node.line, message });
          executionLog.push({ line: node.line, type: 'EXEC_ERROR', tool: node.tool, error: message });
          break;
        }

        try {
          const result = await toolFn(resolvedParams, ctx);
          if (node.output) {
            setPath(ctx, node.output, result);
          }
          executionLog.push({
            line: node.line,
            type: 'EXEC',
            tool: node.tool,
            params: resolvedParams,
            output: node.output,
            result,
          });
        } catch (err) {
          errors.push({ line: node.line, message: err.message });
          executionLog.push({ line: node.line, type: 'EXEC_ERROR', tool: node.tool, error: err.message });
        }
        break;
      }

      case 'COND': {
        const comparisons = [];
        const truthy = evalCondition(node.condition, ctx, comparisons);

        executionLog.push({
          line: node.line,
          type: 'COND',
          matched: truthy,
          comparisons, // hər bir leaf (== != > < contains) müqayisəsinin təfərrüatı
        });

        if (truthy) {
          await runNode(node.action);
        }
        break;
      }

      case 'EMIT': {
        const value = resolveValueNode(node.value, ctx);
        emissions.push(value);
        executionLog.push({ line: node.line, type: 'EMIT', value });
        break;
      }

      case 'ERROR': {
        errors.push({ line: node.line, message: node.message });
        executionLog.push({ line: node.line, type: 'PARSE_ERROR', error: node.message, raw: node.raw });
        break;
      }

      default: {
        const message = `Naməlum AST node tipi: ${node.type}`;
        errors.push({ line: node.line, message });
        executionLog.push({ line: node.line, type: 'RUNTIME_ERROR', error: message });
      }
    }
  }

  for (const node of ast) {
    await runNode(node);
  }

  return {
    ctx,
    emissions,
    result: emissions.length > 0 ? emissions[emissions.length - 1] : null,
    executionLog,
    errors,
  };
}

export default { execute, defaultTools };
