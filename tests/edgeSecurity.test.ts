import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EDGE_MAX_BODY_BYTES,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  bodySizeStatus,
  buildSecurityHeaders,
  ipBucket,
  contentSecurityPolicy,
  edgeBodyGuard,
  edgeSecurityEnabled,
  edgeTrustXff,
  normalisePathname,
  rateLimitKey,
  edgeTimeouts,
  applyEdgeTimeouts,
  shouldCutOnIdle
} from '../server/utils/edgeSecurity'

describe('edgeSecurityEnabled', () => {
  it('off by default / absent / falsey', () => {
    expect(edgeSecurityEnabled({})).toBe(false)
    expect(edgeSecurityEnabled({ APP_EDGE_SECURITY: '' })).toBe(false)
    expect(edgeSecurityEnabled({ APP_EDGE_SECURITY: '0' })).toBe(false)
    expect(edgeSecurityEnabled({ APP_EDGE_SECURITY: 'false' })).toBe(false)
    expect(edgeSecurityEnabled({ APP_EDGE_SECURITY: 'no' })).toBe(false)
  })
  it('on for 1 / true (case-insensitive, trimmed)', () => {
    expect(edgeSecurityEnabled({ APP_EDGE_SECURITY: '1' })).toBe(true)
    expect(edgeSecurityEnabled({ APP_EDGE_SECURITY: 'true' })).toBe(true)
    expect(edgeSecurityEnabled({ APP_EDGE_SECURITY: ' TRUE ' })).toBe(true)
  })
})

describe('contentSecurityPolicy', () => {
  it('strict page CSP for normal paths (frame-ancestors B24, object-src none)', () => {
    const csp = contentSecurityPolicy('/app')
    expect(csp).toContain('default-src \'self\'')
    expect(csp).toContain('object-src \'none\'')
    expect(csp).toContain('frame-ancestors \'self\' https://*.bitrix24.com')
    // strict page CSP must NOT carry the form loader's unsafe-eval
    expect(csp).not.toContain('unsafe-eval')
  })
  it('покрыты ВСЕ 21 официальная облачная зона Б24 — и в frame-ancestors, и в connect-src (#323)', () => {
    const csp = contentSecurityPolicy('/app')
    const zones = ['com', 'ru', 'by', 'eu', 'kz', 'de', 'uk', 'pl', 'fr', 'it', 'ae', 'com.tr', 'in', 'co', 'mx', 'es', 'com.br', 'cn', 'vn', 'jp', 'id']
    const hosts = (directive: string) => (csp.split(';').find(d => d.trim().startsWith(directive)) ?? '')
      .trim().split(/\s+/).filter(t => t.startsWith('https://')).sort()
    const expected = zones.map(z => `https://*.bitrix24.${z}`).sort()
    // frame-ancestors — РОВНО официальный список, без исключений: лишний хост здесь это дыра
    // кликджекинга (чужая страница получает право показать наш портальный экран в своём фрейме).
    expect(hosts('frame-ancestors')).toEqual(expected)
    // connect-src шире ровно на приёмники Метрики (#297), и список РЕГИОНАЛЬНЫЙ: приёмник
    // выбирает не наш код, а счётчик — по региону ПОСЕТИТЕЛЯ. Одного `.ru` мало (живая находка
    // 2026-08-05: посетитель из Беларуси уходит на `mc.yandex.by`, отчёты блокировались, а
    // страница выглядела исправной — то есть аналитика на основном рынке была мертва при зелёных
    // тестах). Список ИМЕНОВАННЫЙ — посторонний хост в исходящих соединениях по-прежнему роняет
    // тест, и это главное, что здесь сторожится: connect-src — канал, по которому со страницы
    // уходят данные. Счётчик работает только на лендинге (во фрейме он себя глушит), но политика
    // одна на все страницы, поэтому разрешение шире фактического использования.
    const METRIKA = ['https://mc.yandex.ru', 'https://mc.yandex.az', 'https://mc.yandex.by', 'https://mc.yandex.co.il', 'https://mc.yandex.com', 'https://mc.yandex.com.am', 'https://mc.yandex.com.ge', 'https://mc.yandex.com.tr', 'https://mc.yandex.ee', 'https://mc.yandex.fr', 'https://mc.yandex.kg', 'https://mc.yandex.kz', 'https://mc.yandex.lt', 'https://mc.yandex.lv', 'https://mc.yandex.md', 'https://mc.yandex.tj', 'https://mc.yandex.tm', 'https://mc.yandex.uz']
    expect(hosts('connect-src')).toEqual([...expected, ...METRIKA].sort())
    // ⚠ И в script-src — тот же список: сам тег `tag.js` тоже подгружается с регионального хоста,
    // а без него счётчик не поднимется вовсе.
    expect(hosts('script-src')).toEqual([...METRIKA].sort())
  })
  it('relaxed form CSP only for /b24-form.html (unsafe-eval + B24 script hosts)', () => {
    const csp = contentSecurityPolicy('/b24-form.html')
    expect(csp).toContain('unsafe-eval')
    expect(csp).toContain('script-src \'self\' \'unsafe-inline\' \'unsafe-eval\' https://*.bitrix24.by')
    expect(csp).toContain('frame-ancestors \'self\'')
  })
})

describe('buildSecurityHeaders', () => {
  it('sets the four hardening headers', () => {
    const h = buildSecurityHeaders('/login')
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(h['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains')
    expect(h['Content-Security-Policy']).toContain('default-src \'self\'')
  })
  it('form path swaps only the CSP', () => {
    expect(buildSecurityHeaders('/b24-form.html')['Content-Security-Policy']).toContain('unsafe-eval')
    expect(buildSecurityHeaders('/b24-form.html')['X-Content-Type-Options']).toBe('nosniff')
  })
})

describe('normalisePathname', () => {
  it('strips query and hash', () => {
    expect(normalisePathname('/b24-form.html?x=1')).toBe('/b24-form.html')
    expect(normalisePathname('/b24-form.html#f')).toBe('/b24-form.html')
    expect(normalisePathname('/app?a=1#b')).toBe('/app')
    expect(normalisePathname('/app')).toBe('/app')
  })
})

describe('edgeTrustXff', () => {
  it('off by default, on for 1/true', () => {
    expect(edgeTrustXff({})).toBe(false)
    expect(edgeTrustXff({ APP_EDGE_TRUST_XFF: '0' })).toBe(false)
    expect(edgeTrustXff({ APP_EDGE_TRUST_XFF: '1' })).toBe(true)
    expect(edgeTrustXff({ APP_EDGE_TRUST_XFF: ' TRUE ' })).toBe(true)
  })
})

describe('rateLimitKey', () => {
  it('edge OFF (behind nginx): trusts the LAST XFF hop (proxy-appended real peer)', () => {
    expect(rateLimitKey(false, false, '1.1.1.1, 2.2.2.2', '10.0.0.1')).toBe('2.2.2.2')
  })
  it('edge ON, trustXff OFF (default, no nginx): ignores spoofable XFF, keys on the real TCP peer', () => {
    expect(rateLimitKey(true, false, '1.1.1.1, 9.9.9.9', '203.0.113.7')).toBe('203.0.113.7')
    // a rotated/forged XFF cannot change the bucket
    expect(rateLimitKey(true, false, 'anything, spoofed', '203.0.113.7')).toBe('203.0.113.7')
  })
  it('edge ON, trustXff ON (verified trusted tunnel): uses the appended last XFF hop', () => {
    expect(rateLimitKey(true, true, '1.1.1.1, 8.8.8.8', '127.0.0.1')).toBe('8.8.8.8')
  })
  it('falls back to "unknown" with no peer', () => {
    expect(rateLimitKey(true, false, undefined, undefined)).toBe('unknown')
    expect(rateLimitKey(false, false, undefined, undefined)).toBe('unknown')
  })
})

describe('bodySizeStatus', () => {
  const MAX = 1000
  it('413 when declared length exceeds max, regardless of topology (defense in depth)', () => {
    expect(bodySizeStatus(false, MAX + 1, MAX)).toBe(413)
    expect(bodySizeStatus(true, MAX + 1, MAX)).toBe(413)
  })
  it('edge ON: missing/zero Content-Length → 411 (chunked would buffer unbounded)', () => {
    expect(bodySizeStatus(true, 0, MAX)).toBe(411)
    expect(bodySizeStatus(true, Number.NaN, MAX)).toBe(411)
  })
  it('edge OFF: missing Content-Length is allowed (nginx caps it)', () => {
    expect(bodySizeStatus(false, 0, MAX)).toBeNull()
  })
  it('within-limit declared length → null (ok) in both topologies', () => {
    expect(bodySizeStatus(true, MAX, MAX)).toBeNull()
    expect(bodySizeStatus(false, 500, MAX)).toBeNull()
  })
  it('EDGE_MAX_BODY_BYTES mirrors nginx client_max_body_size (25 MB)', () => {
    expect(EDGE_MAX_BODY_BYTES).toBe(25 * 1024 * 1024)
  })
})

describe('edgeBodyGuard (global middleware guard)', () => {
  const MAX = 1000
  it('413 when declared Content-Length exceeds max', () => {
    expect(edgeBodyGuard('1001', undefined, MAX)).toBe(413)
  })
  it('411 for a chunked body with NO Content-Length (unbounded buffer)', () => {
    expect(edgeBodyGuard(undefined, 'chunked', MAX)).toBe(411)
    expect(edgeBodyGuard(undefined, 'gzip, chunked', MAX)).toBe(411)
    expect(edgeBodyGuard(undefined, 'CHUNKED', MAX)).toBe(411)
  })
  it('does NOT reject a bodyless / Content-Length:0 request (no header, no chunked)', () => {
    expect(edgeBodyGuard(undefined, undefined, MAX)).toBeNull()
    expect(edgeBodyGuard('0', undefined, MAX)).toBeNull()
  })
  it('chunked WITH a Content-Length → not 411 (length present, framed)', () => {
    expect(edgeBodyGuard('500', 'chunked', MAX)).toBeNull()
  })
  it('within-limit declared length → null', () => {
    expect(edgeBodyGuard('999', undefined, MAX)).toBeNull()
  })
})

describe('login throttle constants', () => {
  it('sane budget: 10 attempts / 15 min', () => {
    expect(LOGIN_MAX_ATTEMPTS).toBe(10)
    expect(LOGIN_WINDOW_MS).toBe(15 * 60 * 1000)
  })
})

describe('заголовки реально ставятся плагином (иначе они не доходят до страниц)', () => {
  // Live-verified regression (#185 п.1): Nitro registers the public-assets handler as the FIRST
  // middleware and it RETURNS for any prerendered file. Every HTML page in this project is
  // prerendered, so headers set from server/middleware/ never reached them — `GET /app` came back
  // with no CSP while `GET /api/health` had the full set, i.e. exactly the pages that need
  // frame-ancestors were the ones missing it.
  //
  // This guard EXECUTES the plugin against a fake nitroApp instead of grepping its source. A source
  // check was the first attempt and it was too weak — proved by mutation: an empty `hook('request')`
  // with the real work moved to `afterResponse`, and an `if (true) return` at the top of the plugin,
  // both reintroduced the bug while keeping the text green. Behaviour is what matters: a hook that
  // fires before the handler chain, and headers that actually land on the event.
  const loadPlugin = async (env: Record<string, string>) => {
    const hooks: Record<string, ((event: unknown) => void)[]> = {}
    const nitroApp = { hooks: { hook: (name: string, fn: (event: unknown) => void) => void (hooks[name] ??= []).push(fn) } }
    vi.stubGlobal('defineNitroPlugin', (fn: (app: unknown) => void) => fn)
    const set: Record<string, string> = {}
    vi.stubGlobal('setResponseHeader', (_e: unknown, k: string, v: string) => void (set[k.toLowerCase()] = v))
    vi.stubEnv('APP_EDGE_SECURITY', env.APP_EDGE_SECURITY ?? '')
    // Плагин зовёт `defineNitroPlugin` на уровне модуля, поэтому импорт ДИНАМИЧЕСКИЙ — заглушка
    // должна стоять раньше вычисления модуля. Кэш модуля не мешает: env читается в момент вызова.
    const mod = await import('../server/plugins/edgeSecurity')
    mod.default(nitroApp)
    return { hooks, set, fire: (path: string) => hooks.request?.forEach(fn => fn({ path })) }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('ON: заголовки ставятся на хуке request — он один срабатывает ДО отдачи статики', async () => {
    const p = await loadPlugin({ APP_EDGE_SECURITY: '1' })
    // Именно `request`: `beforeResponse`/`afterResponse` для статики уже поздно/мимо.
    expect(Object.keys(p.hooks)).toEqual(['request'])
    p.fire('/app')
    expect(p.set['content-security-policy']).toContain('frame-ancestors')
    expect(p.set['x-content-type-options']).toBe('nosniff')
    expect(p.set['referrer-policy']).toBe('strict-origin-when-cross-origin')
  })

  it('ON: у формы Б24 своя, более мягкая CSP (её грузчик иначе не работает)', async () => {
    const p = await loadPlugin({ APP_EDGE_SECURITY: '1' })
    p.fire('/app')
    const page = p.set['content-security-policy']
    p.fire('/b24-form.html?utm=1')
    expect(p.set['content-security-policy']).not.toBe(page)
  })

  it('OFF (за nginx): хук не регистрируется вовсе — второго CSP быть не может', async () => {
    const p = await loadPlugin({})
    expect(p.hooks.request ?? []).toHaveLength(0)
    expect(p.set).toEqual({})
  })

  it('middleware заголовки НЕ ставит — только гард тела, который обязан прерывать запрос', () => {
    // Дубль в middleware не опасен сам по себе, но он — след возврата к сломанной схеме.
    const mw = readFileSync(new URL('../server/middleware/edgeSecurity.ts', import.meta.url), 'utf8')
    expect(mw).not.toContain('buildSecurityHeaders')
    expect(mw).toContain('edgeBodyGuard')
  })
})

describe('CSP приложения и nginx не разъезжаются', () => {
  // `edgeSecurity.ts` заявляет «kept byte-identical to nginx.conf». Заявление ничем не держалось:
  // правка одной строки в nginx.conf молча разводила две политики, и клиент за nginx получал не то,
  // что клиент без него. Сравниваем буквально — источник истины у обеих сторон один.
  const nginx = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8')
  const cspDirectives = (line: string) => line.slice(line.indexOf('"') + 1, line.lastIndexOf('"'))
  const fromNginx = nginx.split('\n')
    .filter(l => l.includes('add_header Content-Security-Policy'))
    .map(cspDirectives)

  it('в nginx.conf ровно две политики: страничная и форменная', () => {
    expect(fromNginx).toHaveLength(2)
  })

  it('страничная CSP совпадает символ в символ', () => {
    expect(buildSecurityHeaders('/app')['Content-Security-Policy']).toBe(fromNginx[0])
  })

  it('форменная CSP совпадает символ в символ (у неё свои послабления под загрузчик формы)', () => {
    // Хвостовая `;` в nginx-строке допустима и семантически ничего не меняет — единственное
    // расхождение, которое мы прощаем; всё остальное обязано быть идентичным.
    const trim = (s: string) => s.replace(/;\s*$/, '')
    expect(trim(buildSecurityHeaders('/b24-form.html')['Content-Security-Policy'] ?? '')).toBe(trim(fromNginx[1] ?? ''))
  })
})

describe('ipBucket: подсеть IPv6 не даёт бесконечных бакетов', () => {
  // Абоненту выдают целую /64, поэтому ключ по полному адресу = 2^64 бесплатных бакетов: один цикл
  // `curl --interface` снимал и троттл логина, и лимит расхода демо (OCR/LLM на токене владельца).
  it('адреса одной /64 схлопываются в один ключ', () => {
    expect(ipBucket('2001:db8:1:2:3:4:5:6')).toBe(ipBucket('2001:db8:1:2:ffff:ffff:ffff:ffff'))
    expect(ipBucket('2001:db8::1')).toBe(ipBucket('2001:db8::dead:beef'))
  })
  it('разные /64 остаются разными ключами', () => {
    expect(ipBucket('2001:db8:1:2::1')).not.toBe(ipBucket('2001:db8:1:3::1'))
  })
  it('IPv4 не трогаем — адрес и есть личность', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7')
  })
  it('IPv4-mapped не режем — иначе разные v4-клиенты слились бы в один бакет', () => {
    expect(ipBucket('::ffff:203.0.113.7')).not.toBe(ipBucket('::ffff:203.0.113.8'))
  })
  it('зона интерфейса не создаёт отдельный бакет', () => {
    expect(ipBucket('fe80::1%eth0')).toBe(ipBucket('fe80::2'))
  })
  it('мусор не притворяется адресом и не схлопывает чужие ключи', () => {
    expect(ipBucket('')).toBe('unknown')
    expect(ipBucket('not:an:address:at:all:x:y:z')).toBe('not:an:address:at:all:x:y:z')
  })
})

describe('edgeTimeouts (#322 — аналог client_body/header_timeout без nginx)', () => {
  it('дефолты зеркалят nginx: idle 60s, headers 60s, total 300s', () => {
    expect(edgeTimeouts({})).toEqual({ socketIdleMs: 60_000, headersTimeoutMs: 60_000, requestTimeoutMs: 300_000 })
  })
  it('env-переопределение с клампом [5s, 1h]; мусор → дефолт', () => {
    expect(edgeTimeouts({ EDGE_SOCKET_IDLE_MS: '30000' }).socketIdleMs).toBe(30_000)
    expect(edgeTimeouts({ EDGE_REQUEST_TIMEOUT_MS: '120000' }).requestTimeoutMs).toBe(120_000)
    expect(edgeTimeouts({ EDGE_SOCKET_IDLE_MS: '1' }).socketIdleMs).toBe(5_000) // ниже пола — кламп
    expect(edgeTimeouts({ EDGE_HEADERS_TIMEOUT_MS: '999999999' }).headersTimeoutMs).toBe(3_600_000)
    expect(edgeTimeouts({ EDGE_REQUEST_TIMEOUT_MS: 'abc' }).requestTimeoutMs).toBe(300_000)
    expect(edgeTimeouts({ EDGE_REQUEST_TIMEOUT_MS: '-5' }).requestTimeoutMs).toBe(300_000)
  })
  it('«0» и пустое значение НЕ означают «выключить» — берётся дефолт (контракт задокументирован)', () => {
    expect(edgeTimeouts({ EDGE_SOCKET_IDLE_MS: '0' }).socketIdleMs).toBe(60_000)
    expect(edgeTimeouts({ EDGE_SOCKET_IDLE_MS: '   ' }).socketIdleMs).toBe(60_000)
  })

  /** Fake http.Server capturing the listeners applyEdgeTimeouts installs. */
  function fakeServer() {
    const srv = {
      timeout: 0,
      headersTimeout: 0,
      requestTimeout: 0,
      idleMs: 0,
      onTimeout: undefined as ((s: { destroy: () => void, edgeReceiving?: boolean }) => void) | undefined,
      onRequest: undefined as ((req: FakeReq) => void) | undefined,
      setTimeout(ms: number, listener?: (s: { destroy: () => void, edgeReceiving?: boolean }) => void) {
        srv.idleMs = ms
        srv.onTimeout = listener
      },
      on(_event: 'request', listener: (req: FakeReq) => void) {
        srv.onRequest = listener
      }
    }
    return srv
  }
  interface FakeReq {
    socket: { destroy: () => void, destroyed?: boolean, edgeReceiving?: boolean }
    headers: Record<string, string | string[] | undefined>
    readableEnded?: boolean
    on: (event: 'end' | 'close', listener: () => void) => unknown
  }
  function fakeReq(headers: Record<string, string> = { 'content-length': '1000' }): FakeReq & { fire: (e: 'end' | 'close') => void } {
    const listeners: Record<string, () => void> = {}
    const socket = {
      destroyed: false,
      destroy() {
        socket.destroyed = true
      },
      edgeReceiving: undefined as boolean | undefined
    }
    return {
      socket,
      headers,
      readableEnded: false,
      on(event, listener) { listeners[event] = listener },
      fire(event) { listeners[event]?.() }
    }
  }

  it('applyEdgeTimeouts ставит все три значения; idle идёт через setTimeout (покрывает уже открытые сокеты)', () => {
    const srv = fakeServer()
    applyEdgeTimeouts(srv, { socketIdleMs: 60_000, headersTimeoutMs: 61_000, requestTimeoutMs: 300_000 })
    expect(srv.idleMs).toBe(60_000)
    expect(srv.headersTimeout).toBe(61_000)
    expect(srv.requestTimeout).toBe(300_000)
  })

  // The load-bearing subtlety: nginx's client_body_timeout applies only WHILE RECEIVING, while Node's
  // server.timeout counts silence in both directions. A handler that computes for minutes with nothing
  // on the wire (demo OCR) must NOT be idle-cut; a half-sent body must.
  it('idle РЕЖЕТ, пока тело ещё принимается (slowloris), и НЕ режет тишину ожидания медленного обработчика (OCR)', () => {
    const srv = fakeServer()
    applyEdgeTimeouts(srv, { socketIdleMs: 60_000, headersTimeoutMs: 60_000, requestTimeoutMs: 300_000 })

    // request arrived, body still in flight → timeout destroys
    const rec = fakeReq()
    srv.onRequest!(rec)
    srv.onTimeout!(rec.socket)
    expect(rec.socket.destroyed).toBe(true)

    // body fully received ('end') → the same idle window spares the socket (handler is working)
    const done = fakeReq()
    srv.onRequest!(done)
    done.fire('end')
    srv.onTimeout!(done.socket)
    expect(done.socket.destroyed).toBe(false)

    // aborted request ('close') must not leave the socket marked as receiving forever
    const aborted = fakeReq()
    srv.onRequest!(aborted)
    aborted.fire('close')
    srv.onTimeout!(aborted.socket)
    expect(aborted.socket.destroyed).toBe(false)

    // bodyless GET (no content-length/transfer-encoding): received the moment headers are in —
    // its (empty) stream is never read, 'end' never fires, so the marker must not wait for it
    const get = fakeReq({})
    srv.onRequest!(get)
    srv.onTimeout!(get.socket)
    expect(get.socket.destroyed).toBe(false)

    // a socket that never presented a request idles for nothing legit → cut
    const silent = {
      destroyed: false,
      destroy() {
        silent.destroyed = true
      }
    }
    srv.onTimeout!(silent)
    expect(silent.destroyed).toBe(true)
  })

  it('shouldCutOnIdle: режет «принимается» и «запроса ещё не было», щадит «тело принято»', () => {
    expect(shouldCutOnIdle(true)).toBe(true)
    expect(shouldCutOnIdle(undefined)).toBe(true)
    expect(shouldCutOnIdle(false)).toBe(false)
  })

  it('плагин гейтится флагом и не трогает сервер за nginx', () => {
    const src = readFileSync(new URL('../server/plugins/edgeTimeouts.ts', import.meta.url), 'utf8')
    // The gate must RETURN before any hook is registered — assert the shape, not mere presence.
    expect(src).toMatch(/if \(!edgeSecurityEnabled\(process\.env\)\) return/)
    expect(src.indexOf('edgeSecurityEnabled(process.env)')).toBeLessThan(src.indexOf('hooks.hook'))
    expect(src).toContain('applyEdgeTimeouts')
  })
})
