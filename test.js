/**
 * test.js
 * İşlətmək üçün: node test.js
 *
 * 4 ssenari yoxlanılır:
 *  1) Uğurlu ardıcıl icra (GOAL -> CTX -> EXEC -> EMIT)
 *  2) Şərtli budaqlanma (? COND -> EXEC / EMIT) — iki fərqli nəticə yolu
 *  3) Sintaksis avto-düzəlişi (!EXECUTE, @Goal kimi səhv yazılışlar)
 *  4) Məntiqi operatorlar (&& / ||) — mürəkkəb şərtlər və qısa-dövrəli qiymətləndirmə
 */

import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { execute } from './executor.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.log(`  ❌ ${message}`);
  }
}

async function runScript(code, ctx = {}) {
  const tokens = tokenize(code);
  const { ast, errors: parseErrors } = parse(tokens);
  const execResult = await execute(ast, { ctx });
  return { tokens, ast, parseErrors, ...execResult };
}

// ==================================================================
console.log('\n🧪 TEST 1: Uğurlu ardıcıl icra (aktiv istifadəçi budağı)');
// ==================================================================
{
  const code = `
@GOAL: Istifadəçi Yoxlanışı
@CTX: userId=102
!EXEC: checkDatabase(id=$userId) :: $user
? $user.status == "active" -> !EXEC: fetchProfile(id=$userId) :: $profile
? $user.status != "active" -> @EMIT: "İstifadəçi aktiv deyil"
@EMIT: $profile
`;
  const res = await runScript(code);

  assert(res.parseErrors.length === 0, 'Parse zamanı xəta olmamalıdır');
  assert(res.ctx.user && res.ctx.user.status === 'active', 'checkDatabase(102) -> status "active" olmalıdır (102 cütdür)');
  assert(res.ctx.profile && res.ctx.profile.id === 102, 'fetchProfile nəticəsi $profile-a yazılmalıdır');
  assert(res.result && res.result.id === 102, 'Yekun @EMIT nəticəsi $profile obyekti olmalıdır');
  assert(res.errors.length === 0, 'Runtime xətası olmamalıdır');
}

// ==================================================================
console.log('\n🧪 TEST 2: Şərtli budaqlanma (qeyri-aktiv istifadəçi yolu)');
// ==================================================================
{
  const code = `
@GOAL: Istifadəçi Yoxlanışı
@CTX: userId=101
!EXEC: checkDatabase(id=$userId) :: $user
? $user.status == "active" -> !EXEC: fetchProfile(id=$userId) :: $profile
? $user.status != "active" -> @EMIT: "İstifadəçi aktiv deyil"
`;
  const res = await runScript(code);

  assert(res.ctx.user.status === 'inactive', 'checkDatabase(101) -> status "inactive" olmalıdır (101 təkdir)');
  assert(res.ctx.profile === undefined, 'Bu yolda fetchProfile ÇAĞIRILMAMALIDIR (profile təyin olunmamalı)');
  assert(res.result === 'İstifadəçi aktiv deyil', 'Yekun @EMIT "İstifadəçi aktiv deyil" olmalıdır');

  const condLog = res.executionLog.filter((l) => l.type === 'COND');
  assert(condLog.length === 2, 'İki COND sətri qiymətləndirilməlidir');
  assert(condLog[0].matched === false, 'Birinci şərt (== active) uyğun gəlməməlidir');
  assert(condLog[1].matched === true, 'İkinci şərt (!= active) uyğun gəlməlidir');
}

// ==================================================================
console.log('\n🧪 TEST 3: Sintaksis avto-düzəlişi (typo tolerantlığı) + xəta izolyasiyası');
// ==================================================================
{
  const code = `
@Goal: Typo Testi
@ctx: score=75
!EXECUTE: checkDatabase(id=1) :: $rec
BU SƏTIR TAMAMILƏ SAXTADIR VƏ HEÇ NƏYƏ UYĞUN GƏLMİR
? $score > 50 -> @EMIT: "Yüksək bal"
@EMIT: "Skript sona çatdı"
`;
  const tokens = tokenize(code);
  const { ast, errors: parseErrors } = parse(tokens);

  // Tokenizer səviyyəsində typo-ların düzgün tanınması
  assert(tokens[0].type === 'GOAL', '"@Goal" -> "GOAL" kimi normallaşdırılmalıdır');
  assert(tokens[1].type === 'CTX', '"@ctx" -> "CTX" kimi normallaşdırılmalıdır');
  assert(tokens[2].type === 'EXEC', '"!EXECUTE" -> "EXEC" kimi normallaşdırılmalıdır');

  // Yanlış sətir sistemi çökdürməməlidir, yalnız ERROR node kimi qeyd olunmalıdır
  const errorNode = ast.find((n) => n.type === 'ERROR');
  assert(errorNode !== undefined, 'Tanınmayan sətir üçün ERROR node yaradılmalı, skript dayanmamalıdır');
  assert(parseErrors.length === 1, 'Cəmi 1 parse xətası qeydə alınmalıdır (digər sətirlər saf qalır)');

  const res = await execute(ast, {});
  assert(res.result === 'Skript sona çatdı', 'Xətadan sonrakı sətirlər normal icra olunmalı və son @EMIT nəticə olmalıdır');
  assert(res.errors.length === 1, 'Executor da parse xətasını errors massivinə ötürməlidir');

  const emitLog = res.executionLog.filter((l) => l.type === 'EMIT');
  assert(emitLog.some((l) => l.value === 'Yüksək bal'), '? $score > 50 şərti (75 > 50) uğurla işləməli və "Yüksək bal" EMIT olunmalıdır');
}

// ==================================================================
console.log('\n🧪 TEST 4: Məntiqi operatorlar (&& / ||)');
// ==================================================================
{
  // 4a) && — hər iki tərəf true olmalıdır ki, əməl icra olunsun
  const codeAnd = `
@GOAL: AND testi
@CTX: userId=102
!EXEC: checkDatabase(id=$userId) :: $user
!EXEC: fetchProfile(id=$userId) :: $profile
? $user.status == "active" && $profile.role == "member" -> @EMIT: "Giriş verildi"
? $user.status == "active" && $profile.role == "admin" -> @EMIT: "Bu heç vaxt olmamalıdır"
`;
  const resAnd = await runScript(codeAnd);
  assert(resAnd.parseErrors.length === 0, '&& ilə şərt parse xətasız olmalıdır');
  assert(resAnd.result === 'Giriş verildi', '&& -> hər iki tərəf true olduqda əməl icra olunmalıdır (status=active, role=member)');

  const condLogAnd = resAnd.executionLog.filter((l) => l.type === 'COND');
  assert(condLogAnd[0].matched === true, '1-ci COND (active && member) true olmalıdır');
  assert(condLogAnd[0].comparisons.length === 2, '&& hər iki leaf müqayisəni qiymətləndirməlidir (short-circuit olmadıqda)');
  assert(condLogAnd[1].matched === false, '2-ci COND (active && admin) false olmalıdır (role admin deyil)');

  // 4b) || — istənilən tərəf true olarsa əməl icra olunur, üstəlik qısa-dövrəli olmalıdır
  const codeOr = `
@GOAL: OR testi
@CTX: score=30
@CTX: vip=true
? $score > 90 || $vip == true -> @EMIT: "Xüsusi giriş"
`;
  const resOr = await runScript(codeOr);
  assert(resOr.result === 'Xüsusi giriş', '|| -> sol tərəf false olsa da, sağ tərəf (vip==true) true olduğu üçün əməl icra olunmalıdır');

  const condLogOr = resOr.executionLog.filter((l) => l.type === 'COND');
  assert(condLogOr[0].comparisons.length === 2, '|| -> sol tərəf false olduğu üçün sağ tərəf də qiymətləndirilməlidir');

  // 4c) || qısa-dövrə: sol tərəf true olanda sağ tərəf HEÇ qiymətləndirilməməlidir
  const codeShortCircuit = `
@GOAL: Qısa-dövrə testi
@CTX: vip=true
@CTX: score=10
? $vip == true || $score > 90 -> @EMIT: "OK"
`;
  const resSc = await runScript(codeShortCircuit);
  const condLogSc = resSc.executionLog.filter((l) => l.type === 'COND');
  assert(condLogSc[0].comparisons.length === 1, '|| qısa-dövrə: sol tərəf (vip==true) true olduğu üçün sağ tərəf HEÇ yoxlanmamalıdır');
}

// ==================================================================
console.log(`\n📊 NƏTİCƏ: ${passed} keçdi, ${failed} uğursuz oldu.`);
if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log('🎉 Bütün testlər uğurla keçdi!');
}
