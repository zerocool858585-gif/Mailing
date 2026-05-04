# Senler и SaleBot рассылки

Локальная утилита для подготовки рассылок в Senler и SaleBot через обычный Chrome с remote debugging.

## Что умеет

- Создавать и проверять рассылки Senler по группам сообществ.
- Создавать блоки и рассылки SaleBot по выбранным аудиториям.
- Редактировать кампанию, аудитории SaleBot и сообщества Senler через локальный интерфейс.
- Загружать картинки через селектор файла.
- Форматировать текст в редакторе.
- Работать в dev-режиме с автообновлением страницы.

## Требования

- Node.js 18 или новее.
- Google Chrome.
- Доступ к Senler и SaleBot в Chrome-профиле, который запускается с remote debugging.

## Установка

```powershell
npm i
```

## Первый запуск

Скопируй примеры настроек:

```powershell
Copy-Item senler/groups.example.json senler/groups.json
Copy-Item salebot/audiences.example.json salebot/audiences.json
```

Запусти Chrome с remote debugging:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\Documents\Codex\chrome-senler" https://senler.ru/
```

Запусти интерфейс:

```powershell
npm run senler-ui
```

Открой:

```text
http://127.0.0.1:4317/
```

## Dev-режим

Для разработки интерфейса:

```powershell
npm run senler-ui:dev
```

При изменении `scripts/senler-ui.mjs` сервер перезапустится, а открытая страница обновится сама.

## Что не хранится в Git

В репозиторий не попадают:

- рабочие кампании `*.ui.json`;
- логи;
- загруженные картинки;
- локальные списки сообществ и аудиторий;
- `node_modules` и npm-cache.

Для передачи настроек другому человеку используй example-файлы или редакторы внутри интерфейса.
