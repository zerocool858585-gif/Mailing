# Инструкция для запуска на Windows

Архив содержит исходники, настройки групп и аудиторий, сохраненные кампании и загруженные изображения. Папки `node_modules`, `npm-cache`, `.git` и логи не включены: они не нужны для передачи и будут созданы заново при установке.

## 1. Установить Python

Python проекту обычно не нужен для обычного запуска, но его стоит установить заранее: часть инструментов Node.js на Windows может использовать Python при сборке зависимостей.

1. Откройте официальный сайт: https://www.python.org/downloads/windows/
2. Скачайте последнюю стабильную версию Python 3 для Windows.
3. Запустите установщик.
4. На первом экране обязательно поставьте галочку `Add python.exe to PATH`.
5. Нажмите `Install Now`.
6. После установки откройте PowerShell и проверьте:

```powershell
python --version
pip --version
```

Если обе команды показывают версии без ошибки, Python установлен правильно.

## 2. Установить Node.js и npm

`npm` устанавливается вместе с Node.js.

1. Откройте официальный сайт: https://nodejs.org/
2. Скачайте LTS-версию для Windows.
3. Запустите установщик и оставьте настройки по умолчанию.
4. После установки откройте новый PowerShell и проверьте:

```powershell
node --version
npm --version
```

Нужен Node.js 18 или новее.

Если PowerShell пишет, что выполнение сценариев отключено, используйте те же команды через `npm.cmd`, например:

```powershell
npm.cmd --version
npm.cmd install
```

## 3. Установить Google Chrome

1. Установите Chrome с официального сайта: https://www.google.com/chrome/
2. В Chrome войдите в аккаунты Senler и SaleBot, с которыми будут создаваться рассылки.

## 4. Распаковать архив

1. Создайте папку, например:

```text
C:\Projects\senler_salebot_mailer
```

2. Распакуйте содержимое архива в эту папку.
3. Откройте PowerShell в папке проекта. Удобный способ: открыть папку в Проводнике, кликнуть правой кнопкой мыши по пустому месту и выбрать `Открыть в терминале`.

## 5. Установить зависимости проекта

В PowerShell внутри папки проекта выполните:

```powershell
npm install
```

После этого появится папка `node_modules`.

Если PowerShell блокирует `npm`, выполните:

```powershell
npm.cmd install
```

## 6. Запустить Chrome в режиме управления

Перед запуском интерфейса нужно открыть отдельный Chrome с remote debugging. Выполните в PowerShell:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\Documents\Codex\chrome-senler" https://senler.ru/
```

Если Chrome установлен в другое место, найдите `chrome.exe` и замените путь в команде.

Важно: используйте именно это открытое окно Chrome для входа в Senler и SaleBot.

## 7. Запустить локальный интерфейс

В отдельном PowerShell в папке проекта выполните:

```powershell
npm run senler-ui
```

Откройте в браузере:

```text
http://127.0.0.1:4317/
```

Для режима разработки с автообновлением можно запускать так:

```powershell
npm run senler-ui:dev
```

## 8. Проверить настройки

В архив включены рабочие настройки:

- `senler/groups.json` - группы Senler;
- `salebot/audiences.json` - аудитории SaleBot;
- `senler/campaign.ui.json` - сохраненная кампания Senler;
- `salebot/campaign.ui.json` - сохраненная кампания SaleBot;
- `senler/uploads/` - изображения, которые использовались в кампаниях.

После распаковки пути к изображениям в сохраненных кампаниях могут указывать на старую папку другого компьютера. Если картинка не прикрепляется, откройте локальный интерфейс, выберите нужное изображение из `senler\uploads` заново и сохраните кампанию.

## 9. Быстрая проверка

Проверьте, что проект запускается:

```powershell
npm test
npm run senler-ui
```

Если PowerShell блокирует `npm`, используйте:

```powershell
npm.cmd test
npm.cmd run senler-ui
```

Если `npm test` прошел без ошибок и интерфейс открылся на `http://127.0.0.1:4317/`, установка готова.

## 10. Частые проблемы

`npm` не найден: закройте PowerShell, откройте новый и проверьте `node --version`. Если не помогло, переустановите Node.js LTS с настройками по умолчанию.

`python` не найден: переустановите Python и поставьте галочку `Add python.exe to PATH`.

Chrome не открывается командой: проверьте путь к `chrome.exe`. Часто он находится в `C:\Program Files\Google\Chrome\Application\chrome.exe`.

Интерфейс не видит Senler или SaleBot: убедитесь, что Chrome запущен с параметром `--remote-debugging-port=9222`, а вход в нужные аккаунты выполнен именно в этом окне Chrome.

Порт `4317` занят: закройте старый запуск проекта или окно PowerShell, где уже запущен `npm run senler-ui`.
