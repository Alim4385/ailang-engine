# AILang

AI Agentlər üçün ultra-sıx, tokenlərə qənaət edən DSL və onun asinxron icraedici motoru.

## Qurulum

```bash
npm install    # asılılıq yoxdur, sadəcə package.json quraşdırır
npm test       # node test.js -> 3 ssenarini yoxlayır
```

## Lokal işə salmaq (Vercel CLI ilə)

```bash
npm i -g vercel
vercel dev
```

Sonra:

```bash
curl -X POST http://localhost:3000/api \
  -H "Content-Type: application/json" \
  -d '{
    "code": "@GOAL: Test\n@CTX: userId=102\n!EXEC: checkDatabase(id=$userId) :: $user\n? $user.status == \"active\" -> @EMIT: \"aktivdir\"\n@EMIT: $user",
    "ctx": {}
  }'
```

## Fayl strukturu

| Fayl | Vəzifə |
|---|---|
| `lexer.js` | Mətni tokenlərə bölür, typo-tolerant (`!EXECUTE` -> `!EXEC`) |
| `parser.js` | Tokenləri AST-yə çevirir, `@CTX`-də bilinən `$dəyişənləri` parse-time əvəz edir |
| `executor.js` | AST-ni asinxron icra edir, `ctx`-i idarə edir, alət (tool) registri saxlayır |
| `api/index.js` | Vercel Serverless handler: `lexer -> parser -> executor` zənciri |
| `system_prompt.txt` | LLM-ə ötürüləcək sistem promptu (yalnız AILang kodu qaytarsın deyə) |
| `test.js` | `node test.js` — 3 ssenari: uğurlu icra, budaqlanma, avto-düzəliş |

## Şərtlərdə `&&` / `||`

Bir `?` sətrində bir neçə müqayisəni birləşdirmək olar:

```
? $user.status == "active" && $user.role == "admin" -> !EXEC: grantAccess() :: $res
? $score > 90 || $vip == true -> @EMIT: "Xüsusi giriş"
```

- Prioritet standart məntiq qaydasına uyğundur: `&&` həmişə `||`-dan güclüdür (parentez yoxdur).
- Qiymətləndirmə **qısa-dövrəlidir** (short-circuit): `&&`-da sol tərəf `false`-dursa sağ tərəf
  heç işə salınmır; `||`-da sol tərəf `true`-dursa sağ tərəf işə salınmır.
- Mürəkkəb qruplaşdırma (mötərizə) lazımdırsa, ardıcıl `?` sətirlərindən istifadə et.
- `executor.js`-in `evalCondition()` funksiyası hər bir leaf müqayisəni `executionLog`-a
  (`comparisons` massivi) yazır ki, debugging zamanı hansı tərəfin nə üçün uyğun/uyğunsuz
  gəldiyi görünsün.

## Alətlər (tools) — DB/API inteqrasiyası

Dil özü heç bir konkret DB-yə bağlı deyil və universal qalır. `checkDatabase`, `fetchProfile`
kimi `executor.js`-dəki `defaultTools` sadəcə test/mock məqsədlidir. Real layihədə bunları
`execute()`-a **kənardan inject** edərək tamamilə əvəz və ya genişləndirmək kifayətdir —
`executor.js`-i dəyişməyə ehtiyac yoxdur:

```js
import { execute } from './executor.js';

await execute(ast, {
  tools: {
    async checkDatabase(params) {
      // real Postgres/Mongo/Supabase sorğusu burda
      const row = await db.query('SELECT * FROM users WHERE id = $1', [params.id]);
      return row;
    },
    async sendEmail(params) {
      // real email inteqrasiyası (SendGrid, Resend s.)
      return { sent: true };
    }
  }
});
```

`api/index.js`-də də eyni prinsiplə `execute(ast, { ctx, tools: myRealTools })` çağırışını
edərək production alətlərini bağlaya bilərsən — dilin sintaksisi və AST strukturu heç
dəyişmir.
