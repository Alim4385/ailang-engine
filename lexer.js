/**
 * lexer.js
 * AILang mətnini sətir-sətir oxuyub strukturlaşdırılmış tokenlərə çevirir.
 * Xırda yazı səhvlərinə (case, əskik/artıq boşluq, yanlış hərf sayı və s.)
 * qarşı tolerantdır — Levenshtein məsafəsinə əsaslanan fuzzy-matching istifadə edir.
 */

// ---- Levenshtein məsafəsi (kiçik xətaları aşkarlamaq üçün) ----
export function levenshtein(a, b) {
  a = a.toUpperCase();
  b = b.toUpperCase();
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // silmə
        dp[i][j - 1] + 1,      // əlavə etmə
        dp[i - 1][j - 1] + cost // əvəzləmə
      );
    }
  }
  return dp[m][n];
}

/**
 * Verilmiş açar sözü (məs. "EXECUTE") bilinən adaylar siyahısı ilə (məs. ["EXEC"])
 * müqayisə edir və ən yaxınını tapır. Tam uyğunluq və ya kiçik məsafə (<=2)
 * ya da prefix uyğunluğu olduqda uyğun adı qaytarır, əks halda null.
 */
export function normalizeKeyword(raw, candidates) {
  if (!raw) return null;
  const upper = raw.toUpperCase().trim();

  // Tam uyğunluq
  if (candidates.includes(upper)) return upper;

  // Prefix uyğunluğu (məs. "EX" -> "EXEC", "EXECUTE" -> "EXEC") — güclü siqnal
  // olduğu üçün uzunluq fərqindən asılı olmayaraq qəbul edilir (min 2 simvol).
  let prefixBest = null;
  let prefixBestDiff = Infinity;
  for (const cand of candidates) {
    if (upper.length >= 2 && (upper.startsWith(cand) || cand.startsWith(upper))) {
      const diff = Math.abs(upper.length - cand.length);
      if (diff < prefixBestDiff) {
        prefixBestDiff = diff;
        prefixBest = cand;
      }
    }
  }
  if (prefixBest) return prefixBest;

  // Əks halda Levenshtein məsafəsinə görə ən yaxın adayı tap (yazı səhvləri üçün)
  let best = null;
  let bestDist = Infinity;
  for (const cand of candidates) {
    const dist = levenshtein(upper, cand);
    if (dist < bestDist) {
      bestDist = dist;
      best = cand;
    }
  }

  // Tolerans həddi: 2 simvola qədər səhvə (yazı səhvi) icazə veririk
  if (bestDist <= 2) return best;
  return null;
}

const AT_KEYWORDS = ['GOAL', 'CTX', 'EMIT'];
const BANG_KEYWORDS = ['EXEC'];

/**
 * Tək bir sətri token obyektinə çevirir. parser.js tərəfindən həm əsas
 * sətirlər, həm də `?` şərtinin daxili "Action" hissəsi üçün istifadə olunur.
 */
export function tokenizeLine(line, lineNumber) {
  const trimmed = line.trim();

  if (trimmed === '') {
    return { type: 'BLANK', raw: line, line: lineNumber };
  }

  if (trimmed.startsWith('#')) {
    return { type: 'COMMENT', raw: line, line: lineNumber };
  }

  if (trimmed.startsWith('@')) {
    const match = trimmed.match(/^@([A-Za-z]+)\s*:?\s*(.*)$/);
    if (!match) {
      return { type: 'UNKNOWN', raw: line, line: lineNumber, reason: '@ ilə başlayan sətir tanınmadı' };
    }
    const keyword = normalizeKeyword(match[1], AT_KEYWORDS);
    if (!keyword) {
      return {
        type: 'UNKNOWN',
        raw: line,
        line: lineNumber,
        reason: `Naməlum @ açar sözü: "${match[1]}" (GOAL, CTX, EMIT gözlənilirdi)`,
      };
    }
    return { type: keyword, content: match[2].trim(), raw: line, line: lineNumber };
  }

  if (trimmed.startsWith('!')) {
    const match = trimmed.match(/^!([A-Za-z]+)\s*:?\s*(.*)$/);
    if (!match) {
      return { type: 'UNKNOWN', raw: line, line: lineNumber, reason: '! ilə başlayan sətir tanınmadı' };
    }
    const keyword = normalizeKeyword(match[1], BANG_KEYWORDS);
    if (!keyword) {
      return {
        type: 'UNKNOWN',
        raw: line,
        line: lineNumber,
        reason: `Naməlum ! açar sözü: "${match[1]}" (EXEC gözlənilirdi)`,
      };
    }
    return { type: keyword, content: match[2].trim(), raw: line, line: lineNumber };
  }

  if (trimmed.startsWith('?')) {
    return { type: 'COND', content: trimmed.slice(1).trim(), raw: line, line: lineNumber };
  }

  return { type: 'UNKNOWN', raw: line, line: lineNumber, reason: 'Sətir heç bir tanınan operatorla başlamır (@, !, ?, #)' };
}

/**
 * Bütün AILang mətnini tokenlərə çevirir.
 * BLANK və COMMENT tipli tokenlər çıxarılır (parser üçün lazımsızdır).
 */
export function tokenize(code) {
  const lines = String(code).split(/\r?\n/);
  const tokens = [];

  lines.forEach((line, idx) => {
    const token = tokenizeLine(line, idx + 1);
    if (token.type === 'BLANK' || token.type === 'COMMENT') return;
    tokens.push(token);
  });

  return tokens;
}

export default { tokenize, tokenizeLine, normalizeKeyword, levenshtein };
