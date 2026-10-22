// The login page: which client is connecting, its redirect host, the RC login form and the access level (D51).
import { html, raw } from 'hono/html'
import { ACCESS_LEVELS, accessAllows, type Access } from '../config.js'

const ACCESS_LABELS: Record<Access, string> = {
  read: 'Только чтение: свободные номера, брони, гости',
  book: 'Чтение и новые брони',
  edit: 'Чтение, новые брони, изменение и отмена броней',
  full: 'Всё, включая удаление броней',
}

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --fg: #1d1d1b; --muted: #6b6b66; --line: #d8d8d2;
  --accent: #1f5fbf; --err: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #1f1f1d; --fg: #ececea; --muted: #a3a39d;
  --line: #3a3a37; --accent: #7aa7ff; --err: #ff8a80; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 system-ui, sans-serif; }
main { max-width: 26rem; margin: 3rem auto; padding: 0 1rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.5rem; }
h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
p { margin: .5rem 0; }
.muted { color: var(--muted); font-size: .9rem; }
.err { color: var(--err); }
label { display: block; margin: 1rem 0 .25rem; font-weight: 600; }
input, select { width: 100%; padding: .6rem; font: inherit; color: inherit; background: transparent;
  border: 1px solid var(--line); border-radius: 8px; }
.row { display: flex; gap: .75rem; margin-top: 1.25rem; }
button { flex: 1; padding: .7rem; font: inherit; border-radius: 8px; border: 1px solid var(--line);
  background: transparent; color: inherit; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
code { font-size: .9rem; }
`

export interface LoginPageProps {
  clientName: string
  redirectHost: string
  /** True when the client redirects to this computer (Claude Code): any local program could pose as it. */
  loopback: boolean
  maxAccess: Access
  access?: Access
  username?: string
  error?: string
}

export function loginPage(p: LoginPageProps) {
  const levels = ACCESS_LEVELS.filter((l) => accessAllows(p.maxAccess, l))
  const selected = p.access && levels.includes(p.access) ? p.access : 'read'
  return html`<!doctype html>
    <html lang="ru">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Вход в RealtyCalendar</title>
        <style>
          ${raw(STYLE)}
        </style>
      </head>
      <body>
        <main>
          <div class="card">
            <h1>Подключение к RealtyCalendar</h1>
            <p><b>${p.clientName}</b> просит доступ к вашему календарю.</p>
            <p class="muted">После входа вы вернётесь на <code>${p.redirectHost}</code>.</p>
            ${
              p.loopback
                ? html`<p class="muted">
                    Это приложение на вашем компьютере. Входите, только если вы сами начали подключение.
                  </p>`
                : ''
            }
            ${p.error ? html`<p class="err" role="alert">${p.error}</p>` : ''}
            <form method="post" action="/login">
              <label for="username">Логин RealtyCalendar</label>
              <input id="username" name="username" autocomplete="username" required value="${p.username ?? ''}" />
              <label for="password">Пароль</label>
              <input id="password" name="password" type="password" autocomplete="current-password" required />
              <label for="access">Доступ</label>
              <select id="access" name="access">
                ${levels.map(
                  (l) => html`<option value="${l}" ${l === selected ? 'selected' : ''}>${ACCESS_LABELS[l]}</option>`,
                )}
              </select>
              <p class="muted">
                Пароль не сохраняется на сервере: он хранится только в зашифрованном токене у ${p.clientName}, чтобы
                входить заново, когда сессия RealtyCalendar истечёт.
              </p>
              <div class="row">
                <button type="submit" name="action" value="deny" formnovalidate>Отмена</button>
                <button type="submit" name="action" value="allow" class="primary">Войти</button>
              </div>
            </form>
          </div>
        </main>
      </body>
    </html>`
}

export function errorPage(message: string) {
  return html`<!doctype html>
    <html lang="ru">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Ошибка подключения</title>
        <style>
          ${raw(STYLE)}
        </style>
      </head>
      <body>
        <main>
          <div class="card">
            <h1>Не удалось подключиться</h1>
            <p class="err">${message}</p>
            <p class="muted">Начните подключение заново в приложении.</p>
          </div>
        </main>
      </body>
    </html>`
}
