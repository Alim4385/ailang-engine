/**
 * api/index.js
 * Vercel Serverless Function.
 *
 * POST body: { "code": "<AILang mətni>", "ctx": { ...başlanğıc dəyişənlər } }
 * Cavab:     { "success": true|false, "result": ..., "executionLog": [...], "errors": [...] }
 */

import { tokenize } from '../lexer.js';
import { parse } from '../parser.js';
import { execute } from '../executor.js';

export default async function handler(req, res) {
  // Sadə CORS dəstəyi (istəsən burdan istənilən origin-ə açıla bilər)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Yalnız POST sorğusuna icazə verilir.' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const { code, ctx } = body;

    if (typeof code !== 'string' || code.trim() === '') {
      res.status(400).json({ success: false, error: '"code" sahəsi tələb olunur və boş ola bilməz.' });
      return;
    }

    // 1) Lexer
    const tokens = tokenize(code);

    // 2) Parser
    const { ast, errors: parseErrors } = parse(tokens);

    // 3) Executor
    const { result, emissions, ctx: finalCtx, executionLog, errors: runtimeErrors } = await execute(ast, {
      ctx: ctx && typeof ctx === 'object' ? ctx : {},
    });

    const allErrors = [...parseErrors, ...runtimeErrors];

    res.status(200).json({
      success: allErrors.length === 0,
      result,
      emissions,
      finalCtx,
      executionLog,
      errors: allErrors,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: `Server xətası: ${err.message}`,
    });
  }
}
