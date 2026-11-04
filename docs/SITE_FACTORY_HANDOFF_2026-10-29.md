# Site Factory — передача работы в новый чат

Дата передачи: **29 октября 2026 года, Europe/Moscow**.

Этот файл — единый контекст для продолжения разработки. Он содержит фактический статус, список выполненного, оставшийся порядок действий, важные технические ограничения, а ниже — полные исходные спецификацию и план, последний отчёт реализации, независимое ревью и решения. Не начинать проект заново и не повторять завершённые этапы.

## 1. Самое важное: на чём остановились

**Этапы 1–13 и дополнительный этап 15 завершены и прошли независимые ревью. Этап 14 реализован и закоммичен, но его независимое ревью нашло одну важную ошибку; исправление ещё НЕ начато. Финальное ревью всей ветки ещё НЕ проводилось.**

Текущий HEAD: `b218336086716e3004e815f009479a83bd4aea71` — `test: add cross-platform packaging and pilot evidence`.

Была назначена первая итерация исправления Task14, но субагент сразу завершился ошибкой лимита использования модели: сообщение предлагало повторить после **4 ноября 2026, 12:00**; часовой пояс этого системного сообщения не уточнён. Это ограничение доступности субагента, а не ошибка кода или теста. Перед этим Astra также была недоступна по лимиту до 2 ноября. В новом чате проверить доступные модели и продолжить с доступным исполнителем; не крутить повторные запросы к исчерпанной модели. Идентификаторы старых субагентов не считать доступными из нового чата.

На момент последней проверки Git **рабочее дерево было чистым**; после этого добавлен только данный запрошенный файл передачи. Нет незавершённого исправления Task14, которое нужно искать или откатывать. Никакие merge/push/публикация приложения не выполнены.

### Ближайшая задача — Task14 / fix round 1 из 5

Ревью: **0 Critical, 1 Important, 2 Minor, 7 CannotVerify**. Вердикты: spec — issues found; quality — needs fixes.

**I1: macOS IPC-сокет создаётся внутри полного пути app-data, что ломает запуск при обычном длинном пути.**

- В `apps/desktop/runtime-guard/src/macos.rs` около строк 481, 489–491 канонизируется каталог данных и добавляется `.guard-<12hex>.sock`.
- Если абсолютный путь длиннее 100 байт, запуск прекращается. Практически это запрещает data root длиннее примерно 75 байт.
- Package smoke сам создаёт `temp_dir()/site-factory-package-smoke-<19digit nanos>` в `apps/desktop/src-tauri/src/worker.rs:500–507`.
- Типичный Mac tmp `/var/folders/ab/012345678901234567890123456789/T` имеет 48 байт. Вместе с именем smoke-каталога data root получается 95 байт, а путь сокета — **120 байт**, ещё до возможного префикса `/private`.
- `scripts/package-desktop.mjs:62–63` обязательно запускает этот smoke на Mac. Это установленная ошибка исходников, а не просто отсутствие Mac для испытаний.

**Принятое решение:** размещать служебный сокет в коротком, эксклюзивно создаваемом приватном каталоге с правами 0700 под фиксированным коротким системным Mac-корнем, например `/private/tmp`. Путь не должен зависеть от длины app-data или переменной `TMPDIR`. База и браузерные профили остаются в app-data. Сохранить аутентификацию fixed helper, token, direct-parent, fd1/2/3/4 и fd5, владение группой процессов и корректную очистку. Не увеличивать предел AF_UNIX, не принимать произвольный сокет от renderer/пользователя и не ослаблять доступ.

Нужны meaningful RED/GREEN на длинном data root и типичной форме Mac smoke-root, проверки собственного cleanup и failure paths, существующие helper-тесты и `cargo check` обеих Mac-архитектур. Реальный запуск macOS по-прежнему отдельный незавершённый acceptance gate.

**FIX_BASE:** `b218336086716e3004e815f009479a83bd4aea71`. После исправления — отдельный commit и свежее независимое **scoped** ревью только `b218336..fixHEAD`, I1 и новая поломка от самой правки. Не повторять полное ревью Task14 или большой тест на 940 тысяч записей только из-за локальной Mac-правки.

Файл с замечанием дословно: `.superpowers/sdd/2026-10-26-site-factory-implementation/task-14-fix-round-1-findings.md`. Полное ревью включено в приложение этого файла.

## 2. Где находится проект — не перепутать

**Активная рабочая копия:**

```text
C:/Users/sazur/.codex/visualizations/2026/10/26/01a1777f-1fed-7cf3-9158-96e8e92fe058/site-factory
```

**Ветка:** `codex/site-factory-pilot`.

**Первичная копия репозитория:** `C:/Users/sazur/Desktop/site-factory`; там в основном исходная документация и общая Git-метаинформация. Последний рабочий код — в указанном linked worktree, а не в первичной папке.

**НЕ РАБОТАТЬ в `C:/Users/sazur/Desktop/speech`.** Это другой проект Take Control. Чат может открыться с `speech` как cwd; каждый shell-вызов должен явно задавать workdir Site Factory.

Linked worktree создан через Git, поскольку нативный инструмент приложения был привязан к другому репозиторию. Не создавать новый checkout автоматически, не переносить исходники и не пытаться привязать к этому проекту worktree speech.

Git common dir расположен в `C:/Users/sazur/Desktop/site-factory/.git`, то есть вне разрешённой на запись рабочей папки. `git add/commit` и Git Bash helpers могут потребовать узкое sandbox escalation. Ранее такие операции разрешались. Известного отказа automatic approval review не было; обычные EPERM/index.lock сами по себе не являются таким отказом.

### Основные документы в репозитории

| Файл | Назначение |
|---|---|
| `docs/superpowers/specs/2026-10-26-site-factory-design.md` | Согласованная спецификация; включена ниже целиком |
| `docs/superpowers/plans/2026-10-26-site-factory-implementation.md` | Полный план; включён ниже целиком |
| `docs/development.md` | Запуск, сборка, проверка ресурсов, ограничения |
| `docs/pilot-report.md` | Фактические результаты и незавершённые внешние проверки |
| `.superpowers/sdd/2026-10-26-site-factory-implementation/progress.md` | Главный журнал реализации, решений и ревью |
| `.superpowers/sdd/2026-10-26-site-factory-implementation/controller-resume.md` | Оперативный контекст; последние пункты выше исторических |
| `.superpowers/sdd/2026-10-26-site-factory-implementation/shared-context.md` | Точные Global Constraints и Tooling |
| `.superpowers/sdd/2026-10-26-site-factory-implementation/final-review-deferred-index.md` | Исторические Minor для итогового ревью |

**Важно:** чекбоксы в исходном implementation plan не обновлялись после каждой задачи. Они описывают план, а не достоверный текущий статус. Статус брать из этого handoff, `progress.md`, реальных commits и review-отчётов. В старых исторических пунктах журнала встречаются уже заменённые границы объёма и промежуточные ошибки; более поздние решения имеют приоритет.

## 3. Что за приложение и что пользователь согласовал

Site Factory — **desktop-панель на Windows и Mac** для массового создания простых сайтов-визиток. Планируется 5000 и более сайтов, пачки по 100, ночная генерация, несколько устройств и продолжение с последнего сохранённого этапа.

- Интерфейс панели — **русский**; сайты — **английские**.
- Сами сайты: статические HTML/CSS/небольшой JavaScript, **без React/Next/Vite**. React/Vite используются только для панели, это согласовано.
- У сайтов нет форм связи, оплаты, логина, wallet-connect, трекинга и иных интерактивных сервисов. Не добавлять вымышленные отзывы, клиентов, контактные данные и показатели ради наполнения.
- Темы — IT и crypto; можно автопридумывать тему или вручную указывать **домен и «о сайте» для конкретного сайта**.
- Домены уже есть. Их приобретение не входит в реализацию.
- Изначально пять собственных направлений оформления и 14 референсов из пользовательского `C:/Users/sazur/Downloads/ref.zip`. Референсы — ориентиры; чужие исходники не копируются.
- Разнообразие важнее сложности. Иллюстрации редки: вероятность по умолчанию 10%, максимум одна тематическая картинка; логотип — отдельный ресурс.
- Роли: `user` запускает конвейер и видит свои/назначенные сайты; `spec-user` дополнительно редактирует через ИИ/визуально и публикует в своей области; `admin` может всё, включая файлы и настройки. Роли проверяет сервер.
- Правки через ИИ входят в первую рабочую версию: запрос → отдельный кандидат → сравнение/refine/reject → Accept в проверенный draft → отдельная Publish.
- Первая публикация нового сайта — автоматически после валидации. Принятие AI-кандидата и визуальный Save **не означают автоматическую повторную публикацию**.
- Визуальный редактор меняет существующие элементы, простую типографику/цвета/ссылки. Структурные изменения поручаются ИИ. Он не заменяет исходники сериализацией живого DOM.
- Храним текущую опубликованную версию и пять предыдущих опубликованных состояний, текущий черновик и данные, необходимые активной работе/восстановлению.
- Технический параллелизм: два задания на доверенное устройство; lease 120 с, heartbeat 30 с; две попытки исправления после проверки и до трёх повторов временной сетевой ошибки. Денежный потолок генерации не вводился.
- При выключении исполнителей уже опубликованные сайты продолжают работать; генерация требует включённого доверенного устройства.

Пользователь хотел отсутствие очевидных признаков общего хостинга, в том числе при исследовании инфраструктуры. **Не обещать невозможность связать домены/владельца; такой гарантии архитектура не даёт.** Множество бесплатных аккаунтов Vercel как способ скрытия или обхода ограничений не реализовывались.

### Выбранный стек и хранение

- **Tauri 2 / Rust / React / TypeScript**, npm workspaces.
- **Node 24.21.0**, Playwright **1.64.1**, закреплённый Chromium **156.0.8078.4**, revision **1248**; ffmpeg1013, на Windows winldd1007.
- Доверенный локальный worker выполняет генерацию и браузерную проверку. Длинные циклы не выполняются внутри Vercel Function.
- **Supabase/PostgreSQL + Auth** — общая база, авторизация, назначения, durable queue и состояние между устройствами.
- **Private R2** — исходники, артефакты, внутренние checkpoints/картинки/резервные ресурсы; хранение исходников отделено от публичного хостинга.
- **Vercel REST** — публикация статических сайтов, один project на сайт в текущей реализации, состояние upload/create/promote/reconcile/DNS.
- **OpenAI Responses API** — инструменты генерации/правок; image flow при необходимости.
- Локальный SQLite — рабочее локальное состояние/демонстрационный режим; он не объявляется облачной синхронизацией.
- Пилот сначала на бесплатных сервисах и небольшом числе личных некоммерческих сайтов. Покупки и итоговый тариф для 5000 реальных сайтов **не утверждались и не измерялись**. Не утверждать, что 5000 сайтов гарантированно стоят $20.

## 4. Что уже сделано по списку

«Завершено» здесь означает код и независимый gate соответствующей задачи; это не заявление, что каждый облачный сервис уже испытан на реальном аккаунте.

| № | Статус | Реализованный результат |
|---|---|---|
| 1 | Завершён, review clean | Реестр, нормализация домена/IDN, дубликаты и RBAC, перезапускаемое локальное состояние |
| 2 | Завершён, review clean | Артефакты/хеши, безопасные файловые инструменты, static/browser validation, изолированный preview |
| 3 | Завершён, review clean | Сохраняемый конвейер генерации, пять своих направлений, закреплённые версии шаблонов и референсов |
| 4 | Завершён, review clean | Desktop-оболочка, русский UI, управление локальным worker через Rust/private pipe |
| 5 | Завершён, review clean | Чат правок, candidate/refinement/compare/accept/reject, CAS от устаревших ответов, отдельная Publish |
| 6 | Завершён, review clean | Responses-адаптер и tools, закрытый доступ к ключу; реальные платные вызовы не выполнялись |
| 7 | Завершён, review clean | Общий API, Supabase Auth/RLS, три роли, приглашения, приватные ресурсы |
| 8 | Завершён, review clean | Durable leases, два исполнителя, checkpoints/heartbeats/revoke/pause/resume/failover, регистрация доверенных устройств |
| 9 | Завершён, review clean | Vercel-публикация, durable intent/outcome, ambiguous effect/reconciliation, account reservations, DNS/HTTPS-состояния |
| 10 | Завершён, review clean | CSV/XLSX, логотипы и bounded import, пачки и реестр 5000, пагинация; нормализованный SQLite вместо растущего JSON |
| 11 | Завершён, review clean | Визуальный инспектор существующих элементов, source-preserving AST edits, безопасный Save в draft, отсутствие второго Accept |
| 12 | Завершён, review clean | История/rollback, current+5 retention/GC, admin export, независимый encrypted backup/restore, quarantine/reconcile |
| 15 | Завершён, review clean | Добавлен после 12: bounded batch transfer и возобновляемая prepare/atomic commit большого восстановления |
| 13 | Завершён, review clean | HTTPS/availability, health leases, безопасная диагностика публикации, токены/частичное время/известные bytes с явными unknown |
| 14 | Код закоммичен, gate НЕ закрыт | Pinned runtime/browser, Windows installer, Mac package scripts/ownership helper, CI, fixture pilot, документация; открыт I1 из ревью |
| Финальное ревью | Не начато | Полный обзор всей ветки после закрытия Task14; затем одна итоговая волна исправлений при необходимости |

### Последние commits, полезные для продолжения

```text
b218336086716e3004e815f009479a83bd4aea71 Task14 packaging/pilot
e45e55df4c5cf4cd83d28d2d75332f9a6f47b573 Task13 quality refactor, clean rereview
da74bb10c7243ed5bade0cd79ce53144e098bf7b Task13 monitoring/activity
448883179e20ec4e282941097e470b443510cff5 Task15 receipt/auth mapping fixes
82d095299d45de374e0f0068b759cc5141b36ca9 Task15 batched recovery
2d2a9e4f9553283e3b66e053b040ea3b7107953a Task12 final fixes
35a6c13 Task12 original implementation
56bcfad Task11 visual-save/source-preservation fixes
00ce847 Task11 original implementation
```

Исходный BASE всей ветки: **`2b2fbefec0f6879fb36bec36c83cd755d1979812`**. Полное итоговое ревью строить от него, а не от `HEAD~1`.

## 5. Фактически выполненные последние проверки

### Один итоговый `npm.cmd run verify` — EXIT 0

Запускались все фазы последовательно, исходники не менялись во время теста. Полный stdout: `.local-state/task14-verify.log`.

| Проверка | Результат |
|---|---|
| `tsc --noEmit` | exit 0 |
| Unit | **417 passed / 2 existing skipped**, 45 файлов, 238.90 с |
| Package boundary | **6 passed** |
| Safe download/extraction | **3 passed** |
| Полный disposable PostgreSQL integration | **120 passed / 3 existing skipped**, 19 файлов, 1312.80 с |
| TypeScript emit + Vite | exit 0, 104 modules, 184 ms |
| Full fixture E2E отдельно | **27/27 passed**, около 1.3 мин |
| Fixture pilot отдельно | **14 E2E + 17 SQL passed**, 70.226 с |
| Main Rust lib | **23 passed / 1 existing ignored OS-store test** |
| Runtime helper | **3/3 passed**, оба Mac target `cargo check` exit 0 |
| Windows | Release/NSIS, реальные headless browser selectors и private Node/Job smoke, извлечённый installer/runtime и corruption/repair проверки прошли |

Два unit skip, один Rust ignored и три внешних integration skip не считать успешными реальными сервисными проверками. Внешние integration skips относятся к реальным Supabase Auth/PostgREST, private R2 и специальному opt-in live Vercel контракту.

Unit запускаются с **одним файловым worker**; все guards и явные concurrency-тесты внутри файлов сохранены. Ранние default-worker прогоны давали разные timeout/EBUSY; их не переименовывали в успех. Текущий штатный launcher явно задаёт подходящий ресурсный бюджет.

Начальный JS chunk уменьшен примерно с 570.42 kB до **248.84 kB**, отдельный Login **247.71 kB**, без увеличения warning threshold. Конфликт NO_COLOR/FORCE_COLOR исправлен только в соответствующих launcher-ах. Старые предупреждения сохранены в старых логах; LF/CRLF notices Git не скрывали глобальными настройками.

### Граница исходников

- Freeze 29.10.2026 07:13:23.458 UTC / 10:13:23 Moscow: 360 Git-visible файлов.
- `.local-state/task14-final-source-manifest.json` SHA256: `e0d11894476952b1c89e737d6b0395e90342cedeb9bd2213a0b73d0c7a221d38`.
- После полного прогона проверены все хеши: **changes: []**.
- Verify-log SHA256: `75d4f8b163f9ca1d6bc3a65a0b9fa03f7ce32501fb224144d86ca608a610a4af`.
- После прогона изменили только два evidence docs, два пути тестовых отчётов и добавили pure prefix helper `tests/integration/evidence.ts`; **0 production files changed**. Прямые default/prefix/traversal проверки и свежий typecheck прошли.
- Финальный source manifest: `.local-state/task14-postgate-source-manifest.json`, 361 файл, SHA256 `f2c8d66ca16518060d0bb62c72a6f102f9de5aa87fecde485cd62c435405f880`.
- Точная дельта: `.local-state/task14-postgate-delta.json`. Последующее изменение только имён evidence не объявлялось новым полным capacity-прогоном.

### Масштаб 5000 сайтов — что именно измерено

Текущий фактический transfer artifact: `.local-state/task14-final-20261029-transfer-5000.json`.

- 5000 сайтов, 30000 состояний/заданий, **940009** исходных metadata records, **270000** physical descriptors.
- Целевая установка — **940022** записи, включая каталог.
- Реально передано **544759302 B metadata** и **222187605 B небольших bodies**.
- Backup metadata/session/other: **3681** вызов; весь restore — **15304** вызова, включая 7381 prepare и один commit.
- max in-flight 2; max JSON request 683675 B / response 683822 B.
- Весь сценарий 1061749.7016 ms, около 17.7 мин; whole commit request 44422.78 ms.
- Это не утверждение, что каждая SQL-операция выполнялась 44 с или что все платформы имеют такие же задержки.
- Inventory digest: `d14eee9514497e7f390df8b78d0e6de5af09aa668f2a33f4a8e74f93779f62a8`.
- Измеренные токены/время в этом fixture синтетические: 30 млн input / 15 млн output, частичное время 3703680000 ms, известные bytes равны реально скопированным bodies. Это **не оплаченные API-вызовы**.

Отдельно metadata-only capacity (`.local-state/task14-full-volume.json`): captured 546796380 B; capture 62635.63 ms; compact index 167714952 B / 160 chunks; **940169 planned ZIP members**, 120001 protected roots. GC (`task14-closure-measured.json`): 22910.12 ms, max measured exclusive fence 7346.84 ms. Наивное старое `zipEntriesBeforeIndex=1210009` не является количеством реально допустимых paired ZIP members.

**Не измерены** полная передача projected **13.5 GB bodies**, максимальный encrypted archive 48 GiB, публикация 5000 настоящих сайтов или реальная стоимость. Большой transfer начинался после доверенного извлечения archive; compositional codec tests отдельно не превращают его в end-to-end 940k encrypted-body throughput test.

## 6. Готовые Windows-артефакты

Относительно активного worktree:

```text
.local-state/cargo-target/x86_64-pc-windows-msvc/release/site-factory-desktop.exe
.local-state/cargo-target/x86_64-pc-windows-msvc/release/runtime/
.local-state/cargo-target/x86_64-pc-windows-msvc/release/bundle/nsis/Site Factory_0.1.0_x64-setup.exe
```

- Installer: **474989857 B**, около **453 MiB**, **unsigned local**.
- Installer SHA256: `6ae5a7b4a73f49cd07ea7dbae307ff83adce0c06e7f9a3183b523d41ee996bcf`.
- Portable main SHA256: `2553ac6b3dc33c665c056b78a2b8fecd04c4be52f0329553e51a9beea1972240`.
- Installed main SHA256: `97d78d174abd2e4bf2fc265f8a81ac9cd8c963cdb712a71a5734c4e369a74b34`.
- Manifest SHA256, скомпилированный в main: `8915e53f934d9951f1ae43d8b8807b4f5174475e057cb7cba979ad99b65b11b1`.
- Exact runtime inventory: **2277 files / 877643103 B**.
- Installer inspection receipt: `.local-state/package/win32-x64/installer-inspection.json`.
- Build receipt: `.local-state/package/win32-x64/package-result.json`.

Pinned Tauri 2.12.2 меняет в main только первый маркер `__TAURI_BUNDLE_TYPE_VAR_UNK` → `..._NSS` для NSIS и возвращает portable main обратно. Поэтому installed и portable SHA различаются. Inspector выводит ожидаемые **полные bytes/hash** установленного main через строго эту замену и сравнивает файл целиком; произвольные различия не разрешены.

Installer **не запускался**. Из него read-only инструментом извлекли файлы, проверили runtime и выполнили только ранние fixed CLI diagnostics без окна/OS vault: synthetic generation, restart persistence, отказ unenrolled managed worker, resource+adjacent-manifest tamper, missing browser и repair/restart. Проверен реальный Windows Job/descendant cleanup. Это компонентное доказательство на Windows10, **не чистая установка Windows11/WebView2/native UI**.

Извлечённая временная копия installer и дублирующая staging-runtime папка уже удалены после сохранения доказательств; **финальный installer и пригодный release/runtime сохранены**.

## 7. Важные архитектурные нюансы — не сломать продолжением

### Авторизация, ключи и данные

- OpenAI/machine key — OS secret store Rust → private Node pipe; никогда renderer/log/prompt/site/archive. Server master DB/R2/Vercel credentials — только сервер.
- Роли и assignment проверяются свежо на сервере; клиентская роль не даёт полномочия.
- Node bootstrap release только после Windows Job attachment. Нет PATH/browser-download fallback в релизе.
- Native IPC: **64000 JSON / 24000 raw resource bytes**. Trusted Node-control batch protocol — отдельно **2 MiB JSON / 1 MiB raw**. Не смешивать эти границы.
- Обычный production server не может открыть demo local DB. Task14 добавил внутренний native-private permit и WeakSet provenance реального DB handle; нельзя заменить его `native:true` из renderer/env/config/archive. Restore наследует capability только в памяти.
- Возвращённые operational IDs/claims не дают права читать private source/картинки после потери scope.

### Очередь и публикация

- Два jobs/worker, health — два отдельных siblings; lease 120s/30s heartbeat; свежая authority и clock после блокировки.
- Не освобождать site/account reservation при неизвестном внешнем эффекте. Cancel/revoke/expiry не превращают unknown publication в безопасный повтор.
- Published history идёт из проверенных settled outcomes, не из `Revision.kind`; revision immutable, draft/published ID могут совпадать.
- Visual Save и AI Accept атомарно CAS-ят правильную base revision, не устанавливают запоздавший результат поверх нового.
- Потеря прав original saver терминально отклоняет pending Save; восстановление роли не должно оживлять старый запрос без нового явного Save.

### Browser/resource trust и Mac ownership

- Main executable содержит точный expected manifest SHA256+target+format. Adjacent checksum не является корнем доверия. Helpers финализируются до manifest, main вне своего inventory, нет self-hash cycle.
- Browser archive hash — controlled official HTTPS retrieval + committed lock; это не независимая опубликованная upstream signature. Node archive checksum — из official SHASUMS. Замена целого unsigned main вне гарантии resource anchor.
- Windows использует фиксированный resource-only `executablePath` для full Chrome и headless shell. Иначе Playwright создаёт `DEPENDENCIES_VALIDATED` внутри immutable runtime и ломает restart. Не разрешать extra marker, skip validation или vendor patch.
- Mac Playwright отрывает browser process group; kill только Node group недостаточен. Fixed proxy передаёт fd1/2/3/4 аутентифицированному watchdog; тот создаёт direct anchor/group и регистрирует ownership **до GO**.
- Direct anchor Child остаётся unreaped (`waitid/WNOWAIT`) до group cleanup. Не сигналить запомненный, уже освобождённый PGID. Proxy death чистит настоящую browser group; watchdog death/owner EOF заставляет anchor очистить свою still-owned group.
- Helper fd5/direct same-helper parent peer/token, аргументы и environment ограничены; нет arbitrary PID/executable/profile broker, sandbox disabling и утечки credentials/FD.
- Mac Tauri generic resources copier dereference-ит symlink. Поэтому **только на Mac** `macOS.files` directory mapping в `Contents/Resources/runtime`, generic resources пуст. Windows mapping прежний. Post-app inventory проверяет modes/links/hash/signing bytes.
- Текущий незакрытый I1 относится к расположению owner socket, а не к отмене этой модели владения.

### Backup/restore, retention и large installation

- Portable logical schema **9**, header-aware совместимость со старой **8**. Operational SQL **010** добавляет health/usage, а 009 transfer state не экспортируется как новая логическая схема. Не путать номер SQL migration и backup schema.
- Backup v1 **adapter-affine**: local→fresh local, managed→fresh managed. Cross-adapter demo→managed migration не обещана.
- Source storage должен быть недоступен при независимом restore; стабильные semantic IDs сохраняются, physical keys remap-ятся, destination Auth mapping проверяется, worker IDs остаются revoked.
- Active work восстанавливается paused/quarantined, terminal jobs не оживают. Никакого автоматического model/provider/publish до явного безопасного release.
- Archive authenticate-before-parse: AES256GCM+scrypt(N131072/r8/p1/maxmem256MiB), bounded STORE-only ZIP64 writer/maintained strict reader, disk-spooled index. Не загружать installation-wide graph в один JS array/Map.
- Формат: до **1M expanded records / 768 MiB metadata / 192 MiB index**, chunks ≤1 MiB; ZIP ≤1M members / 48 GiB plaintext / 32 MiB per member. Paired descriptor index сохраняет backward reader, не ослаблять path/hash/binding/duplicate проверки.
- GC roots: current+5 published/draft/active jobs/unknown publication effects/read-export pins/catalog version edges. 30-day detailed data horizon и 24h orphan grace не означают удаление durable evidence/usage. Unknown closure блокирует pruning соответствующего объекта.
- Shared FIRST database fence для обычных producers; exclusive FIRST для GC/restore. Lock upgrades не разрешены. В exclusive commit нет сетевого/FS/Node crypto.
- Managed snapshot: **объявленный direct/session connection**, на том же физическом session SHARED advisory lock **до BEGIN REPEATABLE READ**, coherent copy+pins, затем fresh READ COMMITTED authority/unlock/release. Unknown/transaction pooler backup отклоняется до lock. Не подбирать endpoint по порту и не создавать вторую DB authority.
- Большой перенос ≤256 metadata / ≤64 resource parts / raw1MiB/JSON2MiB, runner ≤4 in-flight, 64 MiB global staging. Durable prepare с checkpoint progress; exact replay и свежий final ACK не откатывают курсор.
- Destination Auth mapping frozen при первой prepare, проверяется до READY и внутри exclusive commit. JWT session bound при issuance; stable verified same-session refresh только в памяти, другой SID/logout/role loss отменяет scope.
- Snapshot pins 60 min с ограничением 24h от server creation, renew не оживляет expired scope; safe status cache ≤30s для того же exact token не является privilege cache.
- Target final commit: lock wait5s/per-statement15s/cumulative105s; native exact commit client180s, Function Fluid240s. Это технические guards, не доказательство реальной облачной latency.

### Health/usage

- Health связан с текущим settled publication outcome/revision/manifest/frozen policy, а не только revision ID. Для same revision/new outcome старый health unverified, старый completion reject, новый check доступен без ожидания 6h.
- Strict public HTTPS resolution/redirect protections сохранены; unknown policy не объявляется healthy.
- Usage: latest accepted per-job usage один раз, SQL aggregates по точным namespace+key. Cost/full bytes/images/time могут быть null; показываются known subtotal/coverage/provenance.
- Activity — одна aggregate row/job; contiguous sequence/fingerprint и свежий lease; периодические 30s окна. Final/pause interval складывается в той же existing transaction, false pause ничего не потребляет. Не добавлять FULL SQLite fsync на каждый check.
- Ранний счётчик activity hook submissions не был измерением физических fsync; журнал это исправляет. Реальный короткий adapter fixture показал 4 existing TX и 0 дополнительных activity RPC.

## 8. Что остаётся после I1

### Два Minor Task14 — передать финальному ревью, не смешивать с I1 loop

**M1 — provenance manifest.** В manifest нет обещанного source commit. Добавить reviewed source revision и явный dirty/source fingerprint для намеренно dirty packaging; нельзя ложно утверждать clean commit. Integrity per-file anchor при этом работает.

**M2 — verification isolation vendor dependencies.** Smoke запускает ресурсы под checkout, поэтому Node может найти забытый bare package в родительском `node_modules`. Текущий recursive vendor copier существенный safeguard; конкретной отсутствующей зависимости не обнаружено. Финально проверить containment-aware staged graph resolution и/или действительно изолированный smoke без checkout ancestors; clean-machine acceptance остаётся отдельно.

Исторические Minor других этапов (точный индекс приложен): плохая ветка corrupt-state fixture; realpath/junction ownership; readability selector `body *`; RU plural/stage labels; chat refinement labels; compressed SQL readability; local duplicate prepare state fence; различение revoke-after vs действительно наблюдаемого overlap barrier. Часть уже исправлена, например Task15 state-read detector и Task13 same-outcome coverage в Task14. Итоговый reviewer должен **триажить текущее состояние**, а не считать весь исторический список открытыми дефектами или игнорировать его.

### Невыполненные реальные acceptance gates

1. Чистая **Windows11** без установленного Node/npm: installer, WebView2, native GUI, picker/ACL/OS store, window-close/timeout/parent-crash matrix.
2. **macOS14 arm64 и x64**: link/package/install, mode/link inventory после запуска, actual fd3/4 transport, proxy/watchdog/owner failures, headful browser.
3. Publisher signing: Authenticode, Mac signing/notarization/stapling. Текущие unsigned/ad-hoc artifacts не являются подписанным релизом.
4. Настроенные **Supabase/Auth/R2/Vercel/OpenAI**, реальные invitations/refresh/RLS/private bucket/conditional PUT/upload/promote/alias/DNS/HTTPS и конкретные **5–10 личных некоммерческих demo sites**.
5. **Два физических устройства**, реальная передача/сбой сети/выключение; fixture logical workers не заменяют это.
6. Визуальная оценка пользователем; просмотр картинок агентом не означает одобрение пользователем.
7. Полная body/cipher/provider capacity и continuous disk minimum, если нужно это сертифицировать; имеющиеся результаты ограничены заявленным fixture.

`pilot --live --config ...` сейчас выполняет **только preflight** явного конфига и выбранных доменов, не настоящую live генерацию/публикацию. Не выдавать наличие команды за выполненный live pilot.

На этой машине предыдущая попытка осмотра native GUI не получила разрешение вовремя. **Не повторять и не обходить через CUA/headful/chooser.** Pure Rust, fixed CLI/private pipe и headless Chromium были разрешены. Реальные credentials, email/DNS/deploy, создание аккаунтов/покупки/signing actions не выполнялись и не были неявно разрешены командами сборки.

## 9. Порядок продолжения для нового чата

1. Прочитать этот handoff, проверить HEAD/status в **правильном worktree**. Сохранить данный единственный handoff-файл. Не перезапускать задачи 1–13/15.
2. Проверить доступность моделей. Старый owner Task14 сразу упёрся в usage limit и не начал I1. Если его контекст недоступен в новом чате — один свежий исполнитель с Task14 brief, report, review, exact I1, техническими ruling docs; не два параллельных production owner.
3. Перед fix round перечитать `subagent-driven-development/references/fix-loop.md`; выполнить только I1, meaningful targeted tests/Mac compile checks, self-review и отдельный commit. Обновить тот же `task-14-report.md`.
4. Проверить фактический covering output и создать review package **`b218336..fixHEAD`**. Свежий независимый scoped reviewer проверяет I1 + новую поломку от fix. Если новая Important — следующий round, максимум 5, правила в skill; не adjudicate раньше лимита ради окончания.
5. Когда gate чист: отметить Task14 code/review complete, сохранив внешний acceptance как pending. Не объявлять всё production-ready.
6. Перед cleanup сохранить evidence и ВСЕ решения: есть подготовленный `finishing-evidence-plan.md`. В `.local-state/completed-task-evidence/` уже hash-matched копии 36 completed reports/reviews, включая случайно tracked Task1 report. Финальные14/whole-branch ещё нужно добавить. Планировался компактный verified tracked archive + читаемый decision log, ещё **не создан/не закоммичен**.
7. В Git всё ещё tracked `.superpowers/sdd/2026-10-26-site-factory-implementation/task-1-report.md`. До удаления SDD сохранить его verified bytes и убрать tracking **reviewable docs commit**, не просто удалить и оставить dirty. Не удалять SDD до финального ревью и сохранения handoff/evidence.
8. Итоговое независимое ревью **всей ветки**: BASE `2b2fbefec0f6879fb36bec36c83cd755d1979812` → final HEAD. Готов prompt `final-review-request.md` и historical Minor index. Один наиболее способный доступный reviewer, без собственных helpers/повторного full test.
9. Если финальное ревью даст findings: **один** итоговый fix-agent со всем списком, затем **ровно одно** scoped rereview этой волны. Не создавать отдельного fix-agent на каждый пункт и не начинать бесконечные новые широкие волны. Residual adjudication явно в ledger и пользователю.
10. Перед завершением сохранить окончательные отчёты и полный список rulings, проверить Git/status/artifact paths. Branch/worktree оставить, merge/push без явного решения пользователя не выполнять. Сборка с неисправленным Mac I1 или без перечисленных external gates не считается полным релизом.

### Контракт работы с субагентами

- Пользователь прямо одобрил субагентов и не хочет подтверждения на каждом шаге; рутинные инженерные решения записывать и выполнять.
- SDD: один production implementer за раз, свежий независимый reviewer. Controller занимается оркестрацией/документами, не чинит код мимо review.
- Сам implementer **не спавнит** helpers/reviewers.
- Skill требует `fork_turns=none` и явную модель при dispatch; в новом чате учитывать доступные модели, лимиты и актуальные tool instructions.
- До каждой итерации fix читать `fix-loop.md`, для non-DONE `handling-reports.md`, для CannotVerify — `cannot-verify.md` и дать каждому пункту disposition.
- Whole-task review использует original BASE..HEAD, scoped rereview — только предыдущий reviewed HEAD..fixHEAD. Не подменять `HEAD~1`.
- Не повторять большие успешные suites по просьбе reviewer без конкретного нерешённого сомнения. Narrow path/Mac fix не требует ещё 20-минутного SQL capacity прогона.

## 10. Команды и инструменты

Рабочая оболочка PowerShell, Node установлен в `C:/Program Files/nodejs/node.exe`; фиксированные версии в lockfiles.

```powershell
# Все команды — с cwd = активный Site Factory worktree.
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:package
npm.cmd run test:e2e
npm.cmd run verify
npm.cmd run pilot -- --fixtures
npm.cmd run package:desktop -- --target win32-x64
```

Это справочник, **не инструкция немедленно повторить все команды**: последние полные результаты уже сохранены. Для нового исправления выбирать покрывающую проверку.

**Важно для Windows фильтра интеграционных тестов:**

```powershell
& 'C:/Program Files/nodejs/node.exe' 'scripts/test-integration.mjs' ... -t '^(?!.*actual900009)'
```

Не проводить такой caret-фильтр через `npm.cmd`: cmd съедает `^`, из-за чего однажды случайно стартовал тяжёлый fixture. Его имя сохранило marker `actual900009`, хотя текущий объём 940009. Перед запуском проверить реальные имена и selector. Не считать отфильтрованный fixture проверенным.

Все Cargo-команды **обязательно**:

```powershell
$env:CARGO_TARGET_DIR = (Join-Path (Get-Location) '.local-state/cargo-target')
$env:SITE_FACTORY_TEST_NODE = 'C:/Program Files/nodejs/node.exe'
$env:CARGO_INCREMENTAL = '0'
$env:CARGO_PROFILE_DEV_DEBUG = '0'
$env:CARGO_PROFILE_TEST_DEBUG = '0'
```

Не использовать унаследованный `C:/speech-vulkan-ninja` и не удалять его. Для release также debug0/ограниченный job count согласно package script. Mac targets: `aarch64-apple-darwin`, `x86_64-apple-darwin`; установленные std target позволяли `cargo check`, но не реальный link/run.

Helpers SDD, запускаются через `C:/Program Files/Git/bin/bash.exe` с явным cwd и при необходимости узкой escalation:

```text
C:/Users/sazur/.codex/skills/subagent-driven-development/scripts/task-brief
C:/Users/sazur/.codex/skills/subagent-driven-development/scripts/review-package
```

Skills доступны локально: `subagent-driven-development`, `test-driven-development`, `verification-before-completion`, `requesting-code-review`, `finishing-a-development-branch`, `using-git-worktrees`, `brainstorming`, `graphify` и др. Проект уже имеет согласованную спецификацию и план; не запускать новое интервью по всему продукту. Graphify установлен по прежнему запросу пользователя, но это не свидетельство готового актуального knowledge graph; сначала проверить реальные файлы, не выдумывать его наличие.

## 11. Диск, очистки и сохранность доказательств

На момент большого прогона место было ограничено. Использовали hard floor **2 GiB free**, retained preparation ≤2 GiB, native growth ≤3 GiB относительно измеренного baseline, installer+одна extraction ≤1.5 GiB. Значения free — сэмплы, а не непрерывное измерение peak.

- Baseline Cargo logical 3779502099 B; новые release intermediates выросли примерно на 2.55 GB.
- После installer inspection доказательства сохранены; удалены **только 8 точно inventoried generated paths**: 6 Task14 release dependency/build/fingerprint dirs, собственная extraction и дубликат staged runtime. Фактически вернули 3399811072 B с учётом hardlinks. Pre-task debug/registry/download caches и current release/runtime/main/installer сохранены.
- Во время большого prepare удалены **только 8 новых Mac compressed archives / 723167042 B** после lock SHA/birth/containment проверок и сохранения headers/modes/notices evidence.
- Ещё **5 новых Windows compressed archives / 370310712 B** удалены уже **после** освобождения commit/spool; это нельзя приписывать предотвращению commit disk-full.
- Source locks/URLs/хеши/recipe/7zz inspector binary/source archives сохранены. Повторная offline preparation может потребовать вернуть удалённые archives; их отсутствие сейчас ожидаемо.
- Начальная оценка временной потребности 3 GiB была недостаточной как blanket reservation. Рекомендация для нового full gate: **не менее 8 GiB свободно после retained outputs**, как консервативный план, не доказанный peak. Всегда перемерять.
- После прогона было примерно 7.12 GB free. При подготовке этого handoff `Get-PSDrive C` показал уже **120592293888 B free**: состояние хоста изменилось извне. Не считать старый дефицит текущим и не проводить очистки автоматически; заново измерить.
- Не удалять пользовательские файлы/другие workspaces/pre-task caches/current binaries ради теста. Любое recursive move/delete Windows: сначала resolve/check absolute target внутри согласованной папки, затем native PowerShell `-LiteralPath`, без cross-shell построения destructive commands.

### Ошибка исторических имён evidence — честно сохранить ограничение

Большой Task14 test переноса уже использовал prefix, а unchanged retention test писал старые имена `task13-full-volume.json` / `task13-closure-measured.json`.

- Оригинальный Task13 raw full-volume JSON перезаписан; его старые значения и исходный SHA остались в Task13 report/ledger. Не воссоздавать raw timings и не выдавать новый JSON за старый.
- Оригинальный closure **успели сохранить до overwrite**: `.local-state/task13-reviewed-closure-before-task14.json`, SHA256 `4eaffc73c7f819adaf98c89e933360571d3c99f7bf7b0debd8bee0e6e77188e4`.
- Текущие outputs скопированы в `task14-full-volume.json` (SHA `c1d5bab9b6fe567b6d22a60357bd9e5cdbc96528c412511b2a0e0cec1c5a51e9`) и `task14-closure-measured.json` (SHA `a58e83694047a861c92ffaa8189a7dc9ab2af50438518b9a0633e8b7ab2b3b04`).
- Тестовые пути исправлены через pure `evidence.ts`, без production/guard/SQL change и без повторного большого прогона.
- Task15 исторический transfer отдельно сохранён как `.local-state/task15-reviewed-transfer-5000.json`, SHA `f9d1d9beb81b2b0e04a6a5ab19830a99703d6cf74c8dff7fa39257a55db68b3a`.
- Task13 transfer `.local-state/task13-transfer-5000.json` SHA `a504fa14e5bef6217389e39bdfad2385a9a7eb120a7092a2c623ebb6bceb77b0b` — отдельная ранняя boundary, не текущий Task14 run.

## 12. Визуальные материалы и честный scope

`.local-state/pilot/` содержит `run.json`, пять direction JSON и `*-1440.png` / `*-375.png`. Имена означают ширину исходного Chromium screenshot, отдельно проверенную в тесте. Сами PNG — **снимки preview modal панели**, фактический размер 1086×681 / 376×898; видимое clipping и shaded panel не являются full-page изображением сайта. Agent просмотрел все пять desktop и три mobile; у editorial на375 длинное слово переносится внутри — замечание о качестве, не отдельный утверждённый редизайн.

`.local-state/managed-invite-pending-viewport.png` — настоящий1280×800 viewport/scroll reset/fullPage:false; старый full-page stitching artifact не подтвердился. Это headless browser UI fixture, не native GUI acceptance.

## 13. Минимальный стартовый запрос в новом чате

> Продолжи Site Factory по приложенному handoff. Работай в указанном активном worktree, не в speech. Не повторяй завершённые задачи и успешные большие прогоны. Сначала исправь единственный Important I1 из Task14 review: Mac owner socket при длинном app-data/temp path, fix round1 от b218336. Затем отдельное scoped rereview, закрытие Task14, сохранение evidence/решений и итоговое ревью всей ветки от 2b2fbef. Используй субагентов по доступности моделей, один production owner за раз. Реальные внешние сервисы/GUI/signing/deploy не объявляй проверенными и не запускай без соответствующей конкретной среды/авторизации. Пользователь уже разрешил обычные инженерные действия без повторных подтверждений.

---

# Приложения: точные исходные документы и решения

Ниже помещены неизменённые копии действующих документов на момент передачи. Они нужны для одного самодостаточного файла; их старые чекбоксы/исторические формулировки не отменяют фактический статус в начале handoff.


---

# A. Согласованная спецификация — полный текст

Источник: `C:/Users/sazur/.codex/visualizations/2026/10/26/01a1777f-1fed-7cf3-9158-96e8e92fe058/site-factory/docs/superpowers/specs/2026-10-26-site-factory-design.md`

Архитектура тестовой версии панели для массового создания статических сайтов. Дата: 26 октября 2026 года. Статус: согласовано пользователем, включая отдельный сценарий редактирования сайтов через ИИ.

Цель — сначала проверить полный путь на 5–10 личных некоммерческих демосайтах, измерить качество, скорость и расход ресурсов, затем решать вопрос платных тарифов и роста до 5000 и более сайтов. Рабочее название приложения — Site Factory; окончательное название можно выбрать позже.

Согласованы Vercel для публикации, бесплатный пилот, Supabase Free для учёта и авторизации, приватный Cloudflare R2 для файлов, распределение прав и технические значения по умолчанию ниже. Согласование архитектуры не означает покупку или подключение этих сервисов.

# Назначение и границы

Приложение для Windows и macOS принимает домены, создаёт англоязычные одностраничные сайты об IT и криптовалюте и публикует их. Оно поддерживает как информационные страницы, так и презентации концепций продуктов. Основной сценарий посетителя — прочитать описание.

Пачка может содержать 100 доменов. Для каждого домена ИИ придумывает отдельную тему; поле «О сайте» позволяет вручную задать содержание конкретной строки. Параллельная работа нескольких устройств и ночная генерация обязательны. Если все рабочие устройства выключены, новые сайты не генерируются; уже опубликованные продолжают обслуживаться хостингом.

Сайты содержат HTML, CSS и небольшой JavaScript без React, Next.js, Vite и других клиентских фреймворков. Панель управления может использовать React. В сайтах нет форм, регистрации, платежей, подключения кошельков, личных кабинетов, аналитических трекеров и несуществующих функций. Не придумываем отзывы, клиентов, команду, награды, контакты и показатели успешности. Концепцию продукта описываем как концепцию, а фактические утверждения берём из вводных.

Качество должно быть аккуратным и достаточным для простой визитки; разнообразие важнее сложных эффектов. SEO и продвижение не входят в задачу. Нужны технические title, charset и viewport. Предлагаемый дополнительный параметр — noindex, включённый по умолчанию для пилота; он не делает публичный сайт секретным.

Не входят в первую версию: облачный круглосуточный генератор, полноценный редактор перетаскиванием блоков, произвольные серверные приложения для посетителей, массовая автоматизация разных регистраторов и обещание невозможности связать сайты между собой.

# Варианты реализации

| Подход | Что получаем | Издержки |
|---|---|---|
| Управляемые сервисы и локальные рабочие устройства | Tauri, Supabase для учёта и очереди, R2 для файлов, Vercel для публикации | Несколько аккаунтов и ограничения бесплатных тарифов, но нет своего сервера |
| Собственный сервер для API и PostgreSQL | Больше контроля над очередью, пользователями и фоновыми процессами | Постоянная аренда, обновления, резервирование и обслуживание |
| Только локальное приложение и Vercel | Самый простой одиночный эксперимент | Не обеспечивает общий надёжный учёт, три роли и передачу задач между устройствами |

Для проекта выбран первый подход. Полностью локальный вариант не отвечает согласованной работе на нескольких устройствах; собственный сервер пока добавляет расходы. Поставщики изолируются за интерфейсами хранения, публикации и генерации, чтобы смена тарифа или провайдера не требовала переписывать интерфейс приложения.

# Состав системы

| Часть | Технология и ответственность |
|---|---|
| Панель | Tauri 2, React, TypeScript; таблица сайтов, очереди, редактор и настройки |
| Нативная часть | Rust; файловые диалоги, защищённое хранение локальных секретов, запуск доверенного рабочего процесса |
| Рабочий процесс | Node.js и TypeScript; генерация, обработка файлов, проверка в Chromium через Playwright |
| Управляющий API | TypeScript на Vercel; проверка прав, очередь, выдача ограниченного доступа к файлам, публикация |
| Учёт и авторизация | Один Supabase-проект: PostgreSQL и Auth для всех сайтов и пользователей |
| Архивы и версии | Один приватный R2 bucket с разделением объектов по внутренним идентификаторам сайтов |
| Опубликованные сайты | Отдельный Vercel-проект на сайт, статическая загрузка файлов без framework build |
| Генерация | OpenAI Responses API с инструментами чтения и изменения файлов в каталоге задания |

Панель обращается к управляющему API. API проверяет пользователя и работает с общей базой. Доверенные рабочие устройства получают задания через API, сохраняют результаты в R2 и просят API выполнить публикацию в Vercel. Посетитель получает файлы непосредственно с Vercel.

PostgreSQL — источник истины. Локальный SQLite допустим как кэш интерфейса и незавершённого локального ввода, но не как общая очередь. Один репозиторий хранит код приложения, миграции и собственные шаблоны; отдельные Git-репозитории для тысяч сайтов не требуются.

Основа выбора: [архитектура Tauri](https://v2.tauri.app/concept/architecture/), [внешние процессы Tauri](https://v2.tauri.app/develop/sidecar/), [вызов инструментов в OpenAI API](https://developers.openai.com/api/docs/guides/function-calling). Конкретную модель выбираем по результатам пилота, не фиксируем по предположению о цене.

# Пользователи и рабочие устройства

Предлагаемый охват прав: user и spec-user видят свои и назначенные им сайты и пачки; admin видит всё. Администратор создаёт или приглашает пользователей и назначает сайты. Открытая самостоятельная регистрация в пилоте не нужна.

| Действие | user | spec-user | admin |
|---|---|---|---|
| Ввод доменов, импорт и запуск своих пачек | Да | Да | Да |
| Статус, просмотр сайта, отмена своей незавершённой генерации | Да | Да | Да |
| Изменения через ИИ и визуальный редактор | Нет | Да | Да |
| Публикация исправления и откат сайта в своей области доступа | Нет | Да | Да |
| Скачивание архивов, работа с деревом исходников | Нет | Нет | Да |
| Пользователи, роли, интеграции, шаблоны и рабочие устройства | Нет | Нет | Да |

Все ограничения проверяются сервером, включая прямые запросы к API и объектам хранения. Роль из клиентского интерфейса не считается подтверждением полномочий. Чувствительные таблицы закрыты от прямого клиентского доступа; доступ через Supabase дополнительно ограничивается RLS. Служебный ключ Supabase остаётся на сервере.

Рабочие процессы запускаются только на устройствах, зарегистрированных администратором как доверенные. User может запустить пачку со своего компьютера, а выполнять её будут доступные доверенные устройства. На них файлы неизбежно доступны владельцу ОС; обычное пользовательское устройство нельзя считать защищённым местом для скрытых исходников.

HTML, CSS и JS публичного сайта доступны любому посетителю. Spec-user также получает содержимое предпросмотра редактируемого черновика. Поэтому «доступ к файлам только admin» означает управление приватными архивами, полным деревом файлов и экспортом через приложение, а не запрет технически извлечь уже показанный в браузере код.

Каждое рабочее устройство имеет отдельную отзываемую учётную запись машины. Она даёт доступ только к назначенным заданиям и краткоживущим ссылкам R2. Ключ OpenAI для пилота задаётся администратором на доверенных устройствах и хранится средствами ОС, без передачи обычным клиентам. Ключи Vercel, R2 и служебный ключ базы хранятся в серверной конфигурации. Ключи не попадают в промпты, HTML, архивы сайта и журналы.

# Ввод данных и интерфейс

Начальный интерфейс панели — на русском; содержимое сайтов — на английском.

Основные экраны: «Сайты», «Пачки», «Редактор сайта», «Референсы и шаблоны», «Рабочие устройства», «Настройки». Последние три раздела с изменением конфигурации доступны admin. В таблице сайтов показываются домен, тема, состояние генерации, опубликованная версия, состояние домена и HTTPS, последняя ошибка.

Пачка создаётся вставкой списка, импортом CSV/XLSX или добавлением строк вручную. Обязательная колонка — domain. Необязательные — about, reference, logo. Поле logo — загруженный файл или сопоставленный локальный файл; автоматическая загрузка произвольных внешних адресов в первой версии не нужна. XLSX читается как данные, формулы и макросы не выполняются.

Перед запуском пользователь видит проверенную таблицу. Домены нормализуются, URL с путём не принимается как отдельный сайт. Повторы внутри пачки и уже занятые в реестре домены отмечаются; повторный импорт не перезаписывает существующий сайт. Ошибочные строки остаются на исправление, корректные можно запустить. Если about пусто, система создаёт тему; если заполнено, использует вводные этой строки.

Домен можно проверить и подключить позднее: отсутствие DNS не блокирует создание файлов. На панели состояние «ожидает DNS» отличается от ошибки генерации.

# Референсы и библиотека оформления

Источник — 14 ссылок из пользовательского ref.zip. Все главные страницы открылись в браузере 26 октября 2026 года. Ниже — первичный разбор композиции и первого экрана, а не аудит всех внутренних страниц или мобильных версий.

| Референс | Что подходит для нашей библиотеки |
|---|---|
| [Folio](https://folio-topaz-delta.vercel.app/) | Тёмная композиция, крупный заголовок с засечками, спокойная палитра |
| [Northstar](https://northstar-template-demo.vercel.app/) | Светлый минимализм, крупная типографика, синий акцент |
| [Waymark](https://waymark-template.vercel.app/) | Мягкий светлый фон, округлая навигация, аккуратная продуктовая подача |
| [Evolv AI](https://evolv-ai-v1.21st.app/) | Тёмный фон, тонкая сетка, просторный центрированный первый экран |
| [Agent AI](https://agent-ai-v1.21st.app/) | Тёмный первый экран с заголовком и пояснением в разных колонках |
| [Dasne AI](https://dasneai-ai-search-visibility-landing-template-v1.21st.app/) | Плотный технологичный стиль, крупный центрированный заголовок |
| [Vorix](https://vorix-creative-digital-agency-react-template-v2.21st.app/) | Очень крупная типографика, асимметричная композиция, жёлтый акцент |
| [Taxo](https://taxo-astro.pages.dev/) | Тёплый кремовый фон, зелёные и охристые акценты, деловая подача |
| [Techlo](https://techlo-astro.pages.dev/) | Насыщенная синяя палитра, технологичная сервисная подача |
| [Techbyte](https://techbyte-astro.pages.dev/) | Корпоративная композиция с оранжевым акцентом; фотозависимый вариант |
| [Upstart](https://upstart-astro.pages.dev/) | Тёмная продуктовая страница с фиолетовым акцентом и сочетанием шрифтов |
| [Startix](https://startix-reactjs-nu.vercel.app/) | Каталог вариантов лендингов; сетка, контрастные акценты и крупные заголовки |
| [Next Elite](https://next-elite-boilerplate.vercel.app/) | Чистые карточки и элементы управления; дополнительный ориентир для панели |
| [Rayz AI](https://rayz-ai.nextjsshop-preview.workers.dev/) | Светлая композиция с большим графическим полем и модульной сеткой |

Предлагаются пять исходных направлений: светлый продуктовый, тёмный технологичный, типографический агентский, классический корпоративный и информационный с акцентом на схему. Последнее направление — наша адаптация для страниц о технологиях, а не готовая копия одного референса.

Для пилота достаточно пяти собственных стартовых шаблонов на HTML/CSS/JS и небольшого набора секций. Референс хранит URL, дату просмотра, описание композиции, палитру, типографику, плотность, допустимые способы адаптации. Исходные тексты, логотипы и фотографии чужих сайтов не переносятся автоматически. Покупка шаблонов и их лицензии не входят в этот этап.

Шаблон служит начальной точкой. ИИ вправе менять порядок и состав секций, разметку и оформление. Разнообразие оценивается по структуре, выравниванию, типографике, плотности и содержанию, а не только по цвету. Система распределяет направления по пачке и избегает одинакового сочетания параметров у соседних заданий; абсолютную уникальность 5000 сайтов это не гарантирует.

Формы, регистрации, отзывы и дополнительные страницы из референсов не становятся требованиями. Кнопки ведут к существующей секции либо к явно указанной пользователем ссылке. Не добавляем кнопки несуществующих функций.

Картинки редки: предлагаемое значение по умолчанию — вероятность 10% и максимум одна тематическая иллюстрация на сайт. Переданный логотип не считается случайной иллюстрацией. Основное оформление строится на тексте, CSS, небольших SVG и разрешённых иконках. Фотозависимые варианты вроде Techbyte адаптируются к этому ограничению. Используем локальные ресурсы сайта; нет общего публичного bucket с картинками всех проектов.

# Генерация и контроль качества

Последовательность сохраняемых этапов:

1. Принять проверенные вводные, создать сайт и задание.

2. Составить тему, содержание, направление оформления и список секций.

3. Выбрать версию шаблона и подготовить ресурсы.

4. Сгенерировать HTML, CSS и необходимый JS.

5. Проверить файлы и отрисовку, выполнить ограниченное исправление найденных ошибок.

6. Сохранить проверенную версию в приватном архиве.

7. Создать статическое развёртывание Vercel и привязать его к записи версии.

8. Подключить домен, проверить выдачу нужной версии и HTTPS.

Модель работает через ограниченные инструменты чтения, записи и изменения файлов в каталоге одного задания. Произвольная командная строка, доступ к домашнему каталогу и секретам не выдаются. Установку пакетов и запуск неизвестных программ сгенерированные сайты не требуют. Референсы, импортированные тексты и код рассматриваются как данные, не как инструкции по управлению приложением.

После каждого завершённого этапа в R2 сохраняется снимок нужных файлов, затем одной транзакцией фиксируются ссылки и состояние задания в базе. Этап считается сохранённым только после обоих шагов. Тема, выбранный стиль и уже созданное изображение при повторе последующих этапов сохраняются.

Проверки включают валидные внутренние пути, отсутствие форм и запрещённых внешних запросов, отсутствие секретов и очевидных заглушек, работающие ссылки, читаемость, отсутствие горизонтального переполнения на ширинах 375 и 1440 пикселей. JS и HTML проверяются в изолированном браузере. Сохраняются снимки экрана и отчёт. Простейшая оценка сходства разметки и параметров оформления помогает выявлять чрезмерные повторы в пачке.

Начальные технические значения: два одновременных задания на рабочее устройство; максимум две попытки исправления по результатам проверки; до трёх повторов временной сетевой ошибки с задержкой. Это предложения, меняемые по результатам пилота. Денежный потолок генерации не вводится. Использование API и число повторов отображаются; одинаковая ошибка не вызывает бесконечную платную генерацию. Ограничения провайдеров обязательны независимо от выбранной пользователем скорости.

Первая публикация нового сайта происходит автоматически после проверки. Не прошедший проверку сайт остаётся в состоянии «нужно внимание»; остальные задания продолжаются. Изменения существующего сайта сначала сохраняются как черновик и публикуются явным действием редактора.

# Общая очередь и восстановление после сбоя

Задание получает только один текущий исполнитель через атомарную операцию в PostgreSQL. Предлагаемые значения аренды задания — 120 секунд, продление каждые 30 секунд. При передаче задания увеличивается номер владения; запись результата от старого исполнителя отвергается.

Рабочее устройство сохраняет контрольную точку в общей базе и R2. Если оно выключилось, другое продолжает с последнего полностью сохранённого этапа. Незавершённый этап может выполняться повторно. Уже совершённый, но не зафиксированный запрос к модели может потребовать повторной оплаты; гарантии единственного платного вызова после аварии нет.

Пауза пачки прекращает выдачу новых этапов; активный этап завершается и сохраняется. Отмена останавливает оставшуюся работу и не удаляет уже опубликованный сайт. Внешний запрос, который уже отправлен, не всегда можно отменить. Статус после такого запроса сначала сверяется с провайдером.

Для каждого сайта одновременно допускается одна операция изменения или публикации. Изменения используют ожидаемый номер исходной версии. При конфликте второй редактор получает сообщение и сохраняемый отдельно вариант, а не молчаливое перезаписывание.

Только управляющий API имеет право менять опубликованное развёртывание. Операция публикации содержит неизменяемый идентификатор намерения, сайт, хэш файлов и целевую версию. Повторный запрос продолжает ту же операцию. При неизвестном результате API сначала сверяет состояние Vercel. Новая публикация этого сайта не начинается, пока предыдущее внешнее действие не установлено как завершённое или окончательно неуспешное. Если это невозможно подтвердить автоматически, операция требует внимания admin. Устаревший рабочий процесс не может самостоятельно переключить домен.

# Исходники и версии

В PostgreSQL находятся пользователи и роли, сайты, назначения, пачки, задания и попытки, рабочие устройства, ссылки на версии, публикации, шаблоны и результаты проверок. HTML и изображения хранятся в R2, а не в строках базы.

Версия содержит неизменяемый набор файлов, манифест с контрольными суммами, вводные, версию шаблона, параметры генерации, результат проверки и дату. Отдельно хранятся указатели на опубликованную версию и текущий черновик.

Предлагаемый срок истории — текущая опубликованная версия и пять предыдущих опубликованных состояний, плюс текущий черновик. Рабочие контрольные точки хранятся до завершения задания; после завершения ненужные промежуточные снимки удаляются с отсрочкой. Журналы подробных попыток — 30 дней по умолчанию, агрегированные показатели сохраняются.

Очистка никогда не удаляет файлы, на которые ссылаются действующий сайт, черновик, выполняемая публикация или сохраняемые версии. Откат публикует сохранённое содержимое как новое действие и не уничтожает предыдущий журнал. Admin может выгрузить автономный ZIP сайта для переноса на другой хостинг.

Архив в R2 и действующий сайт в Vercel находятся у разных провайдеров, но архив всё равно требует резервирования. В пилоте admin выгружает зашифрованный переносимый снимок базы и файлов на своё устройство. Для постоянной эксплуатации добавляется копирование на второе устройство или отдельное хранилище и проверка восстановления. Одна копия в R2 не называется полноценной независимой резервной копией.

Восстановление включает реестр, назначения, версии, контрольные суммы и журнал публикаций. Учётные записи Auth и ключи сервисов восстанавливаются отдельной процедурой; при потере Auth допускается повторное приглашение пользователей и восстановление назначений по стабильным внутренним идентификаторам. Рабочие токены отзываются и выдаются заново.

# Редактирование сайтов с помощью ИИ

Правки через ИИ входят в первую рабочую версию и доступны spec-user и admin для сайтов в их области доступа. У каждого сайта есть собственный чат с историей запросов и результатов. Можно исправлять как ещё не опубликованный черновик, так и уже работающий сайт.

В чате пользователь пишет обычным языком, например: «Сделай первый экран компактнее», «Перепиши описание на более простой английский», «Замени синий цвет на зелёный», «Добавь раздел о принципе работы» или «Полностью переделай оформление, сохранив тексты». ИИ может менять содержание, стили, существующие элементы и структуру страницы. Визуальный редактор — дополнительный способ внести простые правки; он не обязателен для работы с ИИ.

## Как проходит правка

1. Пользователь выбирает сайт и открывает «Изменить с ИИ». Базой служит последний сохранённый черновик, а при его отсутствии — опубликованная версия. По желанию можно выделить конкретный элемент в предпросмотре, чтобы привязать запрос к нему.

2. Пользователь отправляет запрос. Система создаёт задание редактирования с идентификатором сайта и номером исходной версии. Панель показывает ожидание рабочего устройства, выполнение и проверку результата.

3. ИИ получает запрос, актуальные файлы и ресурсы сайта, его исходные вводные и относящуюся к запросу историю. Он изменяет необходимые файлы, сохраняя остальные части сайта и предыдущие ручные правки. Полная переработка допустима по явному запросу.

4. Система проверяет получившийся сайт теми же средствами, что и при первоначальной генерации. Результат сохраняется как отдельный кандидат на замену черновика. Пользователь видит предпросмотр «до» и «после» и краткое описание изменений обычным языком.

5. Можно уточнить запрос, принять результат в черновик или отклонить его. Уточнение продолжает работу над показанным кандидатом; исходный сохранённый черновик остаётся доступен до принятия. Отклонение не меняет ни его, ни опубликованный сайт.

6. Кнопка «Опубликовать» публикует принятый и проверенный черновик. До этого действующий сайт остаётся прежним. После публикации можно вернуться к одной из сохранённых версий.

## Сохранность и продолжение работы

Чат, исходная версия задания, состояние выполнения и ссылки на результаты хранятся в общей системе. Другой авторизованный компьютер может открыть тот же сайт и продолжить работу. Передача задания между доверенными рабочими устройствами использует общую очередь и сохранённые этапы, как при генерации.

Для сайта выполняется одна изменяющая операция за раз. Если пользователь отправляет следующий запрос, пока предыдущий ещё выполняется, интерфейс предлагает дождаться результата или отменить текущий запрос. При изменении исходного черновика другим редактором кандидат не применяется автоматически: пользователь видит конфликт, а запрос можно повторить на свежей версии.

Ошибка модели, отключение устройства или неудачная проверка не меняют текущий сайт и последний сохранённый черновик. Успешные кандидаты остаются доступными до принятия или отклонения; это временные рабочие файлы, которые не увеличивают постоянную историю опубликованных версий.

ИИ соблюдает общие ограничения сайта: одна страница, HTML/CSS/JS, отсутствие форм и других исключённых функций. Он не меняет DNS, аккаунты, ключи и права пользователей. Экспорт исходников остаётся функцией admin; spec-user работает с запросами, предпросмотром и публикацией.

# Визуальное редактирование

Spec-user и admin открывают текущий сайт, выбирают существующий элемент и меняют текст, ссылку, разрешённое изображение, цвет, размер шрифта и простые отступы. Для структурных изменений используется чат «Изменить с ИИ», описанный в предыдущем разделе; через него также доступны любые поддерживаемые правки текста и оформления.

Редактор сохраняет изменения в исходных HTML/CSS, а не в случайно сериализованном DOM после выполнения скриптов. Сгенерированные редактируемые элементы получают внутренние идентификаторы; сопоставление узлов и ресурсов хранится в манифесте версии. Эти данные не содержат идентификаторов аккаунта или общей инфраструктуры. UI редактора отделён от публичного сайта, служебный мост не включается в публикацию.

Предпросмотр работает в отдельном изолированном контексте без Tauri IPC, локальных секретов и доступа к файлам. Скрипты сайта по умолчанию отключены в режиме выбора элементов. Для проверки поведения используется отдельный изолированный браузерный процесс. Сообщения от предпросмотра проверяются по источнику и схеме. Привилегированные команды никогда не вызываются напрямую из DOM сайта.

Редактор проверяет ожидаемый номер версии при сохранении. ИИ редактирует последний сохранённый черновик с учётом ручных правок. Если правка не может быть безопасно применена, она предлагается отдельным вариантом. Публикация черновика повторяет проверки и фиксирует новую версию.

# Домены и публикация

В пилоте домены добавляются через Vercel API. Приложение показывает записи DNS, которые требует провайдер; admin вносит их у своего регистратора. Автоматизация DNS добавляется после определения фактического регистратора. Неизвестный DNS-провайдер не блокирует разработку генератора.

Первоначально проверяется технический адрес развёртывания, затем пользовательский домен. Состояния различаются: файлы готовы, развёртывание готово, ожидается DNS, проверяется HTTPS, опубликовано, ошибка. «Опубликовано» означает, что собственный домен отдаёт ожидаемую версию по HTTPS.

Все публикации проходят общую очередь провайдера. Для Hobby — не больше одного параллельного развёртывания и с учётом суточного лимита, включая исправления и откаты. При исчерпании квоты готовые сайты ожидают, не пересоздаются и не теряют файлы. Лимиты проверяются при подключении тарифа; HTTP 429 учитывает указания провайдера.

Размещённые страницы не подключают общий публичный архив, общую аналитику или служебный API панели. Однако Vercel как провайдер, DNS, сертификаты, содержание и оформление могут давать исследователю признаки связи. Обещание скрыть общего владельца от целенаправленного исследования в архитектуру не входит.

Проверка доступности и HTTPS выполняется доверенным рабочим процессом по расписанию с очередью и задержкой между сайтами. В пилоте предлагаемая частота — раз в 6 часов при наличии работающего устройства; видна дата последней проверки. Если все устройства выключены, мониторинг тоже приостанавливается. Адреса проверки ограничиваются зарегистрированными публичными доменами; локальные и служебные IP не допускаются, в том числе после DNS и перенаправления.

# Стоимость и ограничения пилота

Хостинг тестируется на Vercel Hobby только для личных некоммерческих демосайтов. Коммерческая публикация не становится разрешённой на Hobby только потому, что называется тестом. По документации на 26 октября 2026 года Hobby допускает 200 проектов, 100 развёртываний в день и одно одновременное развёртывание. Это подходит для 5–10 демосайтов, но не для размещения 5000 сайтов по схеме «проект на сайт». Источники: [Hobby](https://vercel.com/docs/plans/hobby), [лимиты](https://vercel.com/docs/limits), [условия использования](https://vercel.com/docs/limits/fair-use-guidelines).

Supabase Free предлагается для общей базы и авторизации пилота: 500 МБ базы, без автоматических резервных копий; проект может приостанавливаться после недели неактивности. Бесплатная квота относится к общей системе, не к каждому сайту. Платный Pro начинается от 25 долларов в месяц; решение о переходе принимается после замеров. [Supabase Pricing](https://supabase.com/pricing)

R2 Standard предлагает 10 ГБ хранения в бесплатной месячной квоте, 1 млн операций класса A и 10 млн класса B; исходящий трафик R2 не тарифицируется. Сверх бесплатного хранения — 0,015 доллара за ГБ в месяц, операции сверх квоты оплачиваются отдельно. [R2 Pricing](https://developers.cloudflare.com/r2/pricing/)

Расчёт ниже — ориентир, не замер референсов. Используются десятичные КБ и ГБ, полные копии каждой версии:

| Средний размер сайта | 5000 текущих сайтов | Текущая и пять предыдущих версий |
|---|---|---|
| 200 КБ | 1 ГБ | 6 ГБ |
| 500 КБ | 2,5 ГБ | 15 ГБ |
| 1 МБ | 5 ГБ | 30 ГБ |

Полные шесть копий появятся только после накопления истории. Черновики, изображения, резервные копии и отчёты добавляют объём. Например, 30 ГБ постоянного хранения R2 Standard дают примерно 0,30 доллара в месяц сверх 10 ГБ бесплатной квоты только за хранение. Итог зависит от операций и фактического учёта объёма.

OpenAI API оплачивается отдельно и в стоимость хостинга не включён. Тариф Vercel Pro за 20 долларов не означает фиксированную полную стоимость всей системы: возможны расходы на базу, использование платформы и дополнительные места. Ничего платного автоматически не подключаем. [Vercel Pro](https://vercel.com/docs/plans/pro-plan)

Первый этап разработки работает с локальными тестовыми адаптерами без платных запросов. Подключение внешних аккаунтов выполняется после выбора пользователем аккаунтов и добавления ключей. Возможное требование банковской карты сервисом не означает разрешение перейти на платный тариф.

# Проверка готовности тестовой версии

Пилот считается успешным, когда выполнены следующие сценарии:

1. Пачка из 10 корректных строк проходит генерацию; ошибки импорта показываются до запуска.

2. Работают оба режима содержания: придуманная тема и ручное описание конкретного сайта.

3. На небольшой выборке представлены пять направлений оформления; пользователь оценивает достаточность разнообразия. Это не доказательство уникальности на масштабе 5000.

4. Параллельно работают два доверенных устройства. Отключение одного после контрольной точки позволяет второму продолжить; старый исполнитель не перезаписывает новую версию.

5. Прямые запросы с ролью user не позволяют редактировать, экспортировать архивы, назначать роли или читать чужие сайты.

6. Spec-user исправляет текст и оформление через чат ИИ, уточняет запрос и получает новый предпросмотр. Отклонение кандидата сохраняет прежний черновик; принятие сохраняет правки, а сайт меняется только после публикации. Дополнительно проверяются структурное изменение через ИИ после ручной правки, продолжение с другого устройства и конфликт с более свежей версией.

7. Возврат к сохранённой версии действительно меняет сайт; при неуспешной публикации предыдущая рабочая версия остаётся доступной.

8. Все реальные демосайты проверены по HTTPS; отсутствующий DNS показан как отдельное ожидание.

9. При лимите провайдера очередь ждёт и затем продолжается. Ошибка одного сайта не ломает пачку.

10. Из резервного снимка восстанавливается один сайт с историей и реестром.

11. Панель и рабочий процесс запускаются на Windows и macOS; macOS требует отдельной фактической проверки на Mac. Подпись и notarization для распространения определяются после локального пилота.

12. Записаны размер файлов, токены и стоимость API, длительность этапов, число исправлений, объём базы и операций хранения. На этих измерениях выбирается следующий тариф и параллелизм.

Без обращения к платному API отдельно прогоняются 100 фиктивных заданий и реестр из 5000 записей: пагинация, фильтры, очередь, повторная доставка и восстановление. Такой тест проверяет управление заданиями, но не подтверждает производительность модели или разрешённость 5000 проектов на бесплатном хостинге.

# Последовательность разработки после согласования

Сначала создаётся отдельный репозиторий нового приложения; существующий проект Take Control не используется как место для кода панели.

Первый результат — полный проход: ввод домена, очередь, генерация, проверка, архив и тестовая публикация, затем правка этого сайта через чат ИИ с предпросмотром и повторной публикацией. Затем добавляются импорт пачек, роли, два рабочих устройства и восстановление. После этого — визуальный редактор, история, подключение доменов и мониторинг. Завершает этап пилот из 5–10 сайтов с замерами и оценкой дизайна.

На усмотрение разработчика остаются конкретные библиотеки таблицы и HTML/CSS-парсера, формат внутренних идентификаторов, способ упаковки Node-процесса для каждой ОС и детали UI. Выбор не должен менять статический формат сайтов, модель прав и правила сохранности. Модель OpenAI, параллелизм и окончательное количество шаблонов уточняются экспериментом.

Для первых интеграционных испытаний понадобятся доступы к выбранным аккаунтам, несколько тестовых доменов и доступ к Mac. Регистратор определяется при подключении первого домена. Эти сведения не нужны для написания кода с тестовыми адаптерами.

Архитектура согласована пользователем 26 октября 2026 года. Приняты Supabase Free и R2 для пилота, доверенные устройства для генерации, доступ user/spec-user к своим и назначенным сайтам, пять предыдущих версий и пять начальных направлений оформления. Редактирование сайта через чат ИИ входит в первый рабочий проход.


---

# B. Рабочий implementation plan — полный текст

Источник: `C:/Users/sazur/.codex/visualizations/2026/10/26/01a1777f-1fed-7cf3-9158-96e8e92fe058/site-factory/docs/superpowers/plans/2026-10-26-site-factory-implementation.md`

# Site Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Построить desktop-панель для создания статических сайтов, индивидуальных правок через ИИ, безопасного предпросмотра и публикации, затем проверить пачки и передачу задач между двумя устройствами.

**Architecture:** Tauri 2 оборачивает React-интерфейс и управляет доверенным Node-процессом через Rust. Общие доменные операции используют порты хранения, очереди, модели и публикации: сначала локальные адаптеры для разработки, затем Supabase, R2 и Vercel. Обычные клиенты работают с API; только зарегистрированные устройства получают задания генерации.

**Tech Stack:** Tauri 2, Rust, React, TypeScript, Node 24 LTS, npm workspaces, Vitest, Playwright Chromium, PostgreSQL/Supabase Auth, R2 S3 API, Vercel REST API, OpenAI Responses API. Vite допустим только как сборщик панели; сайты обходятся без сборщика.

**Spec:** [Согласованная архитектура](../specs/2026-10-26-site-factory-design.md), включая раздел «Редактирование сайтов с помощью ИИ». [Версия в Pages](https://chatgpt.com/space/page_c75ebf27369881918f167ae2b8ee7999).

Статус: архитектура и план реализации согласованы 26 октября 2026 года; реализация начата. Проект находится отдельно от Take Control. Новые аккаунты, платные тарифы, удалённые репозитории и реальные API-вызовы не создаются автоматически.

## Global Constraints

Ниже сохранены точные требования архитектуры; они относятся ко всем задачам.

- «Начальный интерфейс панели — на русском; содержимое сайтов — на английском.»
- «Сайты содержат HTML, CSS и небольшой JavaScript без React, Next.js, Vite и других клиентских фреймворков.»
- «Правки через ИИ входят в первую рабочую версию и доступны spec-user и admin для сайтов в их области доступа.»
- «Визуальный редактор — дополнительный способ внести простые правки; он не обязателен для работы с ИИ.»
- «Для каждого сайта одновременно допускается одна операция изменения или публикации.»
- «Предлагаемые значения аренды задания — 120 секунд, продление каждые 30 секунд.» Эти значения приняты вместе с архитектурой.
- «Начальные технические значения: два одновременных задания на рабочее устройство; максимум две попытки исправления по результатам проверки; до трёх повторов временной сетевой ошибки с задержкой.»
- «Денежный потолок генерации не вводится.»
- «Предлагаемый срок истории — текущая опубликованная версия и пять предыдущих опубликованных состояний, плюс текущий черновик.»
- «Первая публикация нового сайта происходит автоматически после проверки.»
- «Кнопка „Опубликовать“ публикует принятый и проверенный черновик.»
- «Проверки включают валидные внутренние пути, отсутствие форм и запрещённых внешних запросов, отсутствие секретов и очевидных заглушек, работающие ссылки, читаемость, отсутствие горизонтального переполнения на ширинах 375 и 1440 пикселей.»
- «Картинки редки: предлагаемое значение по умолчанию — вероятность 10% и максимум одна тематическая иллюстрация на сайт.»
- «Если все рабочие устройства выключены, новые сайты не генерируются; уже опубликованные продолжают обслуживаться хостингом.»

Технические решения этого плана: один npm workspace; фиксированные версии зависимостей в lockfile; отдельные сборки Windows x64 и macOS arm64/x64. Для текущей версии Playwright целевые системы пилота — Windows 11+ и macOS 14+; более старые ОС не объявлять поддержанными без отдельной проверки. Локальный демонстрационный режим явно обозначен и не считается проверкой облачной синхронизации или реальной модели. Node, Rust и npm уже доступны на текущем Windows-устройстве; Mac ещё нужен для фактической проверки. Версии и системные требования проверяются при закреплении зависимостей.

## Review Focus

Пять особенно важных ситуаций закреплены тестами в указанных задачах:

1. Похожая запись домена, IDN, повторный импорт или URL с путём не создают второй сайт и не перезаписывают первый — задачи 1 и 10.
2. Сбой между загрузкой файла, сохранением этапа и внешним HTTP-эффектом не теряет последнюю сохранённую версию и не запускает публикацию вслепую — задачи 2, 8, 9, 12 и 15. Передача большой копии возобновляется ограниченными пакетами и не требует миллиона последовательных HTTP-вызовов.
3. Одновременная правка с двух устройств и запоздавший ответ модели не затирают новый черновик; история чата отделена от принятой версии — задачи 5 и 8.
4. Содержимое сайта с JavaScript, вредным путём или поддельным сообщением предпросмотра не достигает ключей, файлов ОС и Tauri IPC — задачи 2, 4, 6 и 11.
5. Исчерпание квоты, отозванное устройство, неготовый DNS и выключенные исполнители показываются разными состояниями, а исправные задания продолжаются — задачи 7–10 и 13.

## Порядок и результаты этапов

- **A — локальный рабочий цикл, задачи 1–6.** Настоящее desktop-окно: создать сайт, написать правку в чат, сравнить, принять или отклонить, опубликовать в локальном тестовом адаптере. OpenAI-адаптер можно включить после настройки ключа; демонстрационные ответы подписаны как демонстрационные.
- **B — работа через сервисы, задачи 7–9.** Три роли, приватные файлы, два доверенных устройства, восстановление и реальные публикации на Vercel Hobby.
- **C — полный пилот, задачи 10–14 и дополнительная 15.** Импорт, визуальный редактор, версии, резервирование, мониторинг, сборки и 5–10 реальных демосайтов.

Это части одного приложения. Каждая задача заканчивается проверяемым результатом. Не объявлять приложение завершённым после этапа A.

## Карта файлов и границы

Все пути ниже относительны корню нового репозитория `C:/Users/sazur/Desktop/site-factory`.

| Каталог | Ответственность |
|---|---|
| `apps/desktop/src/` | React UI; никаких мастер-ключей и выполнения сгенерированного кода |
| `apps/desktop/src-tauri/` | Rust-команды, разрешения, private pipe, ключи ОС, упаковка |
| `apps/worker/src/` | Исполнение этапов, модель, инструменты файлов, браузерная проверка |
| `apps/control/src/` | Обработчики HTTP, авторизация и операции управления |
| `apps/control/api/index.ts` | Тонкая точка входа Vercel; долгие циклы здесь не выполняются |
| `packages/contracts/src/` | Типы и схемы входных данных для UI, API, worker |
| `packages/core/src/` | Сайты, очередь, кандидаты, версии и правила прав |
| `packages/adapters/src/` | Локальные и внешние реализации портов |
| `packages/testing/src/` | Детерминированные часы, fake-провайдеры, fixture-файлы |
| `templates/` | Пять собственных HTML/CSS-направлений и их манифесты |
| `references/catalog.json` | 14 URL и описания, без копирования чужих исходников |
| `supabase/migrations/` | Таблицы, grants, RLS и атомарные операции |
| `tests/integration/`, `tests/e2e/` | Межкомпонентные и пользовательские сценарии |
| `docs/` | Спецификация, план, запуск, восстановление и результаты пилота |

Не создавать пустые каталоги и пакеты заранее: они появляются в задаче, которая их использует. Все приложения используют TypeScript strict. Сгенерированные сайты — данные и не входят в исполняемый код workspace.

## Общие интерфейсы

Определить в задаче 1 в `packages/contracts/src/model.ts`; последующие задачи расширяют типы в явно названных файлах. ID — строки UUID, время — целое число миллисекунд UTC.

- `Role = 'user' | 'spec-user' | 'admin'`.
- `Principal = {userId: string; role: Role}`; роль разрешается сервером, не берётся из request body.
- `SiteInput = {domain: string; about?: string; referenceId?: string; logoAssetId?: string}`.
- `Site = {id: string; domain: string; ownerId: string; assignedUserIds: string[]; input: SiteInput; revision: number; draftId: string | null; publishedId: string | null; generationStatus: string; domainStatus: string}`.
- `Revision = {id: string; siteId: string; parentId: string | null; manifestId: string; kind: 'draft' | 'candidate' | 'published'; createdAt: number}`.
- `ArtifactFile = {path: string; bytes: Uint8Array; mediaType: string}`.
- `Manifest = {id: string; siteId: string; files: {path: string; objectKey: string; size: number; sha256: string; sha1: string; mediaType: string}[]; templateVersion: string; createdAt: number}`.
- `Job = {id: string; siteId: string; kind: 'generate' | 'edit'; stage: string; state: 'queued' | 'running' | 'paused' | 'waiting_provider' | 'needs_attention' | 'completed' | 'cancelled'; checkpointId: string | null; baseRevision: number}`.
- `Lease = {jobId: string; workerId: string; generation: number; expiresAt: number}`.
- `ValidationReport = {ok: boolean; issues: {code: string; path?: string; message: string}[]; screenshotIds: string[]}`.
- `AppError.code`: `INVALID_INPUT`, `DUPLICATE_DOMAIN`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `STALE_LEASE`, `PROVIDER_WAIT`, `NEEDS_ATTENTION`.
- `Clock.now(): number`, `IdSource.next(): string`. Тесты не используют реальные задержки.
- `SiteRepository.create(input, principal): Promise<Site>`, `get(id): Promise<Site | null>`, `list(principal, cursor?, limit?): Promise<{items: Site[]; nextCursor: string | null}>`, `compareAndSet(siteId, expectedRevision, patch): Promise<Site>`.
- `ArtifactStore.put(siteId, files, templateVersion): Promise<Manifest>`, `read(manifestId): Promise<ArtifactFile[]>`.
- `Checkpoint = {id:string; jobId:string; stage:string; manifestId:string|null; stateKey:string; createdAt:number}`; `CheckpointStore.save(job: Job, lease: Lease, state: Record<string, unknown>, files: ArtifactFile[]): Promise<Checkpoint>` сохраняет private metadata и файлы до изменения очереди.
- `Queue.enqueue(job): Promise<void>`, `claim(workerId): Promise<{job: Job; lease: Lease} | null>`, `heartbeat(lease): Promise<Lease>`, `checkpoint(lease: Lease, checkpoint: Checkpoint): Promise<void>`, `finish(lease, state): Promise<void>`.
- `PublicationState = 'pending'|'uploading'|'creating'|'checking'|'promoting'|'reconciling'|'waiting_quota'|'awaiting_dns'|'published'|'needs_attention'`.
- `ModelPort.run(request: ModelRequest, tools: FileTools, signal: AbortSignal): Promise<ModelResult>`. `ModelRequest` и `ModelResult` определяются в задаче 3.
- `PublicationPort.advance(intentId: string): Promise<PublicationState>`; PublicationState определён выше, расширенный intent и реальный адаптер — задача 9, локальный fake — задача 3.

Служебные DTO должны быть сериализуемыми: байты через транспорт передаются ресурсами/pipe, не помещаются в обычные JSON-запросы к Vercel Function. Проверка схем выполняется на каждой границе доверия.

---

### Task 1: Реестр сайтов и перезапускаемый локальный режим

**Files:** создать `package.json`, `tsconfig.base.json`, `.gitignore`, `packages/contracts/package.json`, `packages/contracts/src/model.ts`, `packages/contracts/src/inputs.ts`, `packages/core/src/sites.ts`, `packages/core/src/permissions.ts`, `packages/adapters/src/local-state.ts`, `packages/testing/src/clock.ts`; тесты `packages/core/test/sites.test.ts`, `packages/adapters/test/local-state.test.ts`.

**Interfaces:** производит общие типы, `normalizeDomain(value: string): string`, `authorize(principal: Principal, action: Action, site?: Site): void`, `createLocalState(directory: string, clock: Clock): Promise<LocalState>`. `Action` — `site:create|site:read|site:edit|site:publish|site:export|admin:manage`. `LocalState` реализует SiteRepository и атомарное сохранение состояния одним управляющим процессом; это не распределённая БД.

- [ ] **1. Написать тесты нормализации и сохранения.** На временном каталоге создать реестр и проверить:
```ts
expect(normalizeDomain(' HTTPS://EXAMPLE.COM/ ')).toBe('example.com');
expect(() => normalizeDomain('https://example.com/page')).toThrow();
expect(() => normalizeDomain('https://user:pass@example.com')).toThrow();
expect(normalizeDomain('пример.рф')).toBe('xn--e1afmkfd.xn--p1ai');
expect(reopenedSite.domain).toBe('example.com');
expect(duplicateError.code).toBe('DUPLICATE_DOMAIN');
expect(() => authorize(user, 'site:edit', ownedSite)).toThrow();
```
Добавить отказ на IP, localhost, port, query и fragment; домен без схемы принимается. В тесте `reopenedSite` получен через новый createLocalState после закрытия первого.
- [ ] **2. Запустить** `npm test -- packages/core/test/sites.test.ts packages/adapters/test/local-state.test.ts`; до реализации ожидается ошибка отсутствующего модуля.
- [ ] **3. Реализовать интерфейсы и workspace-команды** `test`, `typecheck`, `build`. Локальное состояние сохранять через временный файл и замену под process mutex; повреждённый файл выдаёт ошибку и не перезаписывается пустым состоянием. В production local-state недоступен.
- [ ] **4. Повторить тесты и typecheck**; все проверки зелёные, повторный запуск сохраняет запись.
- [ ] **5. Commit:** `feat: add site registry and local persistence`.

### Task 2: Файлы сайта и изолированная проверка

**Files:** создать `packages/core/src/artifacts.ts`, `packages/adapters/src/local-artifacts.ts`, `apps/worker/src/files/tools.ts`, `apps/worker/src/validation/static.ts`, `apps/worker/src/validation/browser.ts`, `apps/worker/src/preview/server.ts`; тесты `apps/worker/test/files.test.ts`, `apps/worker/test/validation.test.ts`.

**Interfaces:** потребляет ArtifactFile/Manifest/ArtifactStore; производит `FileTools = {list(): Promise<string[]>; read(path: string): Promise<string>; write(path: string, text: string): Promise<void>; replace(path: string, oldText: string, newText: string): Promise<void>}`, `validateSite(files: ArtifactFile[]): Promise<ValidationReport>`, `startPreview(manifestId: string): Promise<{url: string; close(): Promise<void>}>`.

- [ ] **1. Написать тесты containment, контрольных сумм и браузера.** Fixtures — минимальные собственные страницы.
```ts
await expect(tools.write('../outside.txt', 'x')).rejects.toThrow();
await expect(tools.read('C:\\Users\\secret.txt')).rejects.toThrow();
expect((await validateSite(withForm)).ok).toBe(false);
expect((await validateSite(brokenAnchor)).ok).toBe(false);
expect((await validateSite(responsiveSite)).ok).toBe(true);
expect(capturedExternalRequests).toHaveLength(0);
expect(await artifactStore.read(saved.id)).toEqual(originalFiles);
```
Также проверить UNC, drive-relative пути, symlink/junction, URL-encoding traversal, одинаковые имена с разным регистром и прерванное сохранение.
- [ ] **2. Запустить** `npm test -- apps/worker/test/files.test.ts apps/worker/test/validation.test.ts`; ожидаются красные тесты отсутствующей реализации.
- [ ] **3. Реализовать инструменты без shell/eval/npm.** Разрешить index.html, CSS, классический browser JS и локальные ресурсы; исключить package.json, api/, произвольный vercel.json, executable и symlink. Измерять размеры и хэши до фиксации manifest. Preview-server слушает только loopback, выдаёт только текущие файлы по случайному capability URL, не содержит control endpoints.
- [ ] **4. Реализовать Chromium-проверку и выполнить тесты.** `chromiumSandbox: true`, отдельный контекст/профиль, очищенное окружение без ключей, запрет service workers, внешних запросов, WebSocket, popups/downloads. Проверить 375 и 1440 px, внутренние ссылки, ошибки консоли и overflow. Ограничения времени защищают процесс; это не денежный лимит. Не использовать `node:vm` для сгенерированного JS.
- [ ] **5. Commit:** `feat: validate static artifacts in isolated chromium`.

### Task 3: Генератор и пять собственных направлений

**Files:** создать `apps/worker/src/pipeline.ts`, `apps/worker/src/checkpoints.ts`, `apps/worker/src/model/types.ts`, `packages/adapters/src/fake-model.ts`, `packages/adapters/src/fake-publication.ts`, `packages/adapters/src/local-queue.ts`, `templates/catalog.json`, `templates/{light-product,dark-tech,editorial,corporate,diagram}/index.html`, соответствующие `styles.css`, `references/catalog.json`, `apps/desktop/src/features/references/ReferenceLibrary.tsx`; тест `apps/worker/test/pipeline.test.ts`.

**Interfaces:** `ModelRequest = {mode: 'generate' | 'edit'; site: Site; instruction: string; baseManifestId: string | null; conversation: ChatMessage[]; styleId: string; selectedElementId?: string}`; `ChatMessage = {id: string; role: 'user' | 'assistant'; text: string; createdAt: number}`; `ModelResult = {summary: string; inputTokens: number; outputTokens: number; providerResponseId?: string}`; `runJob(job: Job, lease: Lease, deps: WorkerDeps, signal: AbortSignal): Promise<void>`. WorkerDeps: Queue, SiteRepository, ArtifactStore, CheckpointStore, ModelPort, Clock и PublicationPort.

- [ ] **1. Написать fake-provider тесты полного прохода и ошибок.**
```ts
expect(completed.state).toBe('completed');
expect(manualBriefUsed).toContain('user supplied description');
expect(new Set(batchStyles).size).toBe(5);
expect(failed.state).toBe('needs_attention');
expect(repairCalls).toBe(2);
expect(otherJob.state).toBe('completed');
expect(freshJob.publishedId).not.toBeNull();
```
Фиксировать seed; повтор этапа не меняет тему, шаблон или выбранное изображение.
- [ ] **2. Запустить** `npm test -- apps/worker/test/pipeline.test.ts` и получить ожидаемые failures.
- [ ] **3. Реализовать сохраняемые этапы** brief → assets → generate → validate → archive → publication. Тема из about имеет приоритет; пустое about создаёт отдельную английскую IT/crypto-тему. Шаблоны собственные, структура может изменяться моделью. FakeModel детерминированный и возвращает флаг демонстрационного режима в runtime status. Служебные brief, tool transcript и resume metadata идут в отдельный private checkpoint, а не в публикуемый manifest. Публичный артефакт содержит только финальные файлы сайта; тест проверяет отсутствие служебных JSON и истории prompts.
- [ ] **4. Проверить тесты и render пяти шаблонов.** Без форм, выдуманных клиентов/отзывов, framework runtime и внешних shared assets. На старте страницы содержат title/charset/viewport, осмысленные якоря и техническую настройку noindex для пилота. Схемы и простые SVG допустимы. ReferenceLibrary показывает доступные стили и источник; admin может отключить стиль для новых jobs и изменить описание референса. Версия шаблона, уже записанная в job, не меняется. Локальный доступ задаёт authorize; после задачи 7 эти операции используют серверные admin endpoints.
- [ ] **5. Commit:** `feat: add resumable generation pipeline and starter styles`.

### Task 4: Desktop-окно и управление локальным исполнителем

**Files:** создать `apps/desktop/package.json`, `apps/desktop/index.html`, `apps/desktop/src/{main.tsx,App.tsx,app.css}`, `apps/desktop/src/features/sites/{SiteList.tsx,CreateSiteDialog.tsx}`, `apps/desktop/src/lib/desktop-client.ts`, `apps/desktop/src-tauri/{Cargo.toml,build.rs,tauri.conf.json}`, `apps/desktop/src-tauri/src/{lib.rs,commands.rs,worker.rs}`, `apps/desktop/src-tauri/capabilities/main.json`, `apps/desktop/src-tauri/permissions/commands.toml`, `apps/worker/src/stdio.ts`; тесты `tests/e2e/create-site.spec.ts`, Rust unit tests рядом с worker.rs.

**Interfaces:** JSON pipe `DesktopRequest = {id: string; version: 1; method: 'site.list' | 'site.create' | 'job.status' | 'preview.open'; params: unknown}`; ответ `{id, result}` либо `{id,error:{code,message}}`. Rust `dispatch(request: DesktopRequest) -> Result<serde_json::Value, AppError>`; TypeScript `DesktopClient.request<T>(method: string, params: unknown): Promise<T>`. Методы проверяются allowlist и схемами, не строкой shell.

- [ ] **1. Написать сценарий:** открыть панель, создать example.test, увидеть этапы, готовый локальный сайт и явную надпись «Демо — без внешних сервисов». Запрос неизвестного метода и неверной protocol version должен завершаться отказом; сгенерированный контент не получает native bridge.
- [ ] **2. Запустить** `npm run test:e2e -- tests/e2e/create-site.spec.ts`; отсутствие UI/bridge даёт ожидаемый failure.
- [ ] **3. Собрать Tauri-приложение и fixed-path worker.** UI содержит список, создание, статус устройства, переключение разделов. Rust запускает только упакованный/явно заданный developer Node и доверенный script; не принимает executable/path из UI. IPC по stdin/stdout, журналы только stderr, завершение процесса при закрытии приложения. Начальный local mode использует один управляющий процесс.
- [ ] **4. Проверить** `npm run typecheck`, `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`, e2e и `npm run tauri:dev` на Windows. Custom commands перечислить в AppManifest::commands и дать разрешения только main webview; отсутствие `window.__TAURI__` не считать достаточной защитой. Встроенный preview сначала отображает полученные из Chromium снимки; открываемый interactive preview — отдельный Chromium без IPC.
- [ ] **5. Commit:** `feat: add tauri desktop shell and local site workflow`.

### Task 5: Чат правок и принятие кандидата

**Files:** создать `packages/core/src/editing.ts`, `packages/contracts/src/editing.ts`, `apps/desktop/src/features/editor/{SiteEditor.tsx,ChatPanel.tsx,PreviewComparison.tsx}`; изменить local-state.ts, stdio.ts, desktop-client.ts; тесты `packages/core/test/editing.test.ts`, `tests/e2e/ai-edit.spec.ts`.

**Interfaces:** `requestEdit(actor: Principal, siteId: string, instruction: string, expectedRevision: number, candidateId?: string): Promise<Job>`; `acceptCandidate(actor, siteId, candidateId, expectedRevision): Promise<Site>`; `rejectCandidate(actor, siteId, candidateId): Promise<void>`; `getConversation(actor, siteId): Promise<ChatMessage[]>`. Методы pipe: `edit.request|edit.accept|edit.reject|chat.list|site.publish`. Candidate хранит baseRevision, baseDraftId, manifestId, status и проверку.

- [ ] **1. Написать проверки принятия, отклонения, уточнения и конфликта.**
```ts
expect(afterCandidate.publishedId).toBe(before.publishedId);
expect(afterReject.draftId).toBe(before.draftId);
expect(afterAccept.draftId).toBe(candidate.id);
expect(afterAccept.publishedId).toBe(before.publishedId);
expect(staleAcceptError.code).toBe('CONFLICT');
expect(secondInstructionBase).toBe(candidate.manifestId);
expect(afterRestartConversation).toEqual(savedConversation);
```
Дополнительно user получает FORBIDDEN; неудачная правка не меняет два указателя версии.
- [ ] **2. Запустить** `npm test -- packages/core/test/editing.test.ts`, затем `npm run test:e2e -- tests/e2e/ai-edit.spec.ts`; оба пока красные.
- [ ] **3. Реализовать состояния** queued/running/checking/ready/rejected/accepted/conflict. Последний принятый черновик — база первой правки; уточнение использует выбранного кандидата, но не меняет baseRevision. При втором активном запросе показать «Дождитесь завершения или отмените текущую правку». Предпросмотр «до/после», summary, кнопки «Уточнить», «Принять в черновик», «Отклонить», «Опубликовать».
- [ ] **4. Проверить сценарий create → edit → refine → accept → publish → edit → reject.** Только явная публикация правки переключает publishedId. Не перегенерировать весь сайт ради изменения текста; scope определяется запросом. При конфликте сохранить вариант отдельно и предложить повтор на актуальном черновике.
- [ ] **5. Commit:** `feat: add per-site ai editing and candidate review`.

### Task 6: Реальный Responses API и ключ на доверенном устройстве

**Files:** создать `packages/adapters/src/openai/{responses.ts,tool-loop.ts,images.ts}`, `apps/worker/src/prompts/{generate.ts,edit.ts}`, `apps/desktop/src-tauri/src/secrets.rs`, `apps/desktop/src/features/settings/ModelSettings.tsx`; тесты `packages/adapters/test/openai.test.ts`, `apps/worker/test/prompts.test.ts`.

**Interfaces:** `createResponsesModel(config: {apiKey: string; model: string; imageModel?: string}, transport?: typeof fetch): ModelPort`; Rust `SecretStore.put(name, secret)`, `get(name)`, `delete(name)` с ОС-адаптерами. `generateImage(description, seed): Promise<ArtifactFile | null>`; выбор картинки сохраняется до вызова, максимум одна, шанс 0.1, logo отдельно.

- [ ] **1. Написать тесты HTTP-фикстурами** function_call → function_call_output → final. Повтор неизвестного инструмента отвергается; refusal/incomplete и 429 дают явное состояние. Assertions: сохранены полные replayable output items и call_id; английский контент; старый ручной текст не меняется при запросе только цвета; ключ отсутствует в логах, prompts и артефакте; одинаковый seed не создаёт повторную картинку.
- [ ] **2. Запустить** `npm test -- packages/adapters/test/openai.test.ts apps/worker/test/prompts.test.ts`; реальные HTTP-вызовы запрещены тестовым транспортом.
- [ ] **3. Реализовать Responses tool loop.** Собственные list/read/write/replace tools со strict schemas; сохранять нужные output items, а не только output_text. Источник истины для чата и файлов — своя БД/R2, не provider TTL. Сетевые повторы максимум 3; повторяющийся цикл без изменений останавливать с needs_attention. Завершать по final/refusal/cancellation. Конкретные text/image модели выбрать из доступных аккаунту при подключении, не подменять без сообщения.
- [ ] **4. Реализовать ключи ОС и проверить offline suite.** Rust получает ключ из Windows Credential Manager/macOS Keychain и передаёт worker по private pipe; renderer после ввода не получает его обратно. Удаление/смена ключа останавливает новые calls. Для preview Chromium формируется очищенное env. Живой smoke запускать только после настройки ключа и показывать токены; без ключа демонстрационный режим остаётся доступен. Отсутствующая image model не вызывает незаявленных платных вызовов: показать отключённую интеграцию изображений, базовые сайты продолжаются без иллюстрации.
- [ ] **5. Commit:** `feat: integrate responses tools and native secret storage`.

### Task 7: Общий API, три роли и приватное хранилище

**Files:** создать `apps/control/src/{app.ts,auth.ts,errors.ts}`, `apps/control/src/routes/{sites.ts,editing.ts,workers.ts,uploads.ts}`, `apps/control/api/index.ts`, `packages/adapters/src/{supabase-repository.ts,r2-store.ts}`, `supabase/migrations/001_registry_auth_artifacts.sql`, `apps/desktop/src/lib/remote-client.ts`, `apps/desktop/src/features/auth/Login.tsx`, `apps/desktop/src/features/settings/{UsersSettings.tsx,IntegrationsSettings.tsx}`, `apps/control/src/routes/admin.ts`; тесты `tests/integration/auth.test.ts`, `tests/integration/uploads.test.ts`.

**Interfaces:** HTTP DTO используют типы задач 1/5. `verifyUser(jwt: string): Promise<Principal>`, `verifyWorker(token: string): Promise<{workerId:string}>`; `POST /sites`, `GET /sites?cursor&limit`, `POST /sites/:id/edits`, `POST /sites/:id/candidates/:candidateId/accept|reject`, `GET /sites/:id/chat`, admin `POST /workers/enroll`, `POST /workers/:id/revoke`. `POST /uploads/prepare` принимает lease и manifest metadata, возвращает одноразовые object keys и краткоживущие PUT URL; `POST /uploads/complete` фиксирует проверенный manifest.

- [ ] **1. Написать матрицу server-side доступа:** user редактирование/экспорт/admin → 403; spec-user свой сайт → разрешено, чужой → 404/403; admin → полный доступ. Подмена role/user_metadata, чужой objectKey, истёкший JWT и отозванный worker отвергаются. Проверить, что HEAD metadata без проверки bytes не признаётся доказательством SHA-256.
- [ ] **2. Запустить** `npm run test:integration -- auth uploads` на локальной PostgreSQL/Supabase test-среде; сначала ожидаются failures. Если среда ещё не настроена, показать skip как skip и подготовить её в этой задаче, не выдавать mock за проверку RLS.
- [ ] **3. Реализовать схемы, миграции и API.** Таблицы users/memberships/sites/assignments/batches/jobs/workers/revisions/artifacts/edit_requests/chat/deployments/health/audit. JWT проверять через JWKS/getClaims; свежую роль брать из БД. RLS+grants на клиентских таблицах; service key только server. Приглашение, назначение ролей и сайтов только admin; экраны UsersSettings и IntegrationsSettings показывают конфигурацию и статус подключений без чтения мастер-ключей в renderer. Worker token хранить на сервере хэшированным и отзывать независимо от user session.
- [ ] **4. Проверить upload и private preview.** Node загружает напрямую в R2 S3 endpoint, URL действует 10 минут, сервер выбирает keys; неизменяемые snapshots, signed Content-Type и conditional put. complete проверяет принадлежность/размер; реальные SHA проверяются при чтении перед употреблением. Backend передаёт клиенту только разрешённый preview, не общий bypass secret Vercel. R2-адаптер реализует ArtifactStore и CheckpointStore с разными закрытыми префиксами; private checkpoint никогда не входит в публичный deployment. Прямой анонимный R2 GET запрещён. Secret/service credentials отсутствуют в desktop bundle.
- [ ] **5. Commit:** `feat: add managed auth api and private artifacts`.

### Task 8: Два исполнителя и восстановление по сохранённым этапам

**Files:** создать `supabase/migrations/002_queue_leases.sql`, `packages/adapters/src/postgres-queue.ts`, `apps/control/src/routes/jobs.ts`, `apps/worker/src/runner.ts`, `apps/desktop/src/features/workers/WorkerList.tsx`; изменить pipeline.ts; тесты `tests/integration/queue.test.ts`, `tests/integration/failover.test.ts`.

**Interfaces:** реализация Queue; `POST /worker/jobs/claim`, `POST /worker/jobs/:id/heartbeat|checkpoint|finish` требуют worker token и актуальный Lease. `runWorker(deps: WorkerDeps, workerId: string, signal: AbortSignal): Promise<void>`. Изменения сайта используют compareAndSet и тот же номер владения.

- [ ] **1. Написать конкурентные SQL-тесты** с двумя соединениями и управляемыми часами.
```ts
expect(claimedJobIds).toHaveLength(new Set(claimedJobIds).size);
expect(firstLease.expiresAt - now).toBe(120_000);
expect(heartbeatIntervalMs).toBe(30_000);
expect(maxParallelJobsPerDevice).toBe(2);
expect(staleCheckpointError.code).toBe('STALE_LEASE');
expect(resumedJob.stage).toBe(lastCommittedStage);
```
Сбой после R2 upload до commit оставляет объект-сироту, не ложный завершённый этап; принятие кандидата с устаревшей базой → CONFLICT.
- [ ] **2. Запустить** `npm run test:integration -- queue failover`; ожидать failures без SQL-функций.
- [ ] **3. Реализовать claim одной транзакцией FOR UPDATE SKIP LOCKED.** Lease generation увеличивается при новой выдаче; heartbeat/checkpoint/finish CAS. Не держать транзакцию во время API вызова. SECURITY DEFINER с пустым search_path и закрытым EXECUTE; вызов только сервером. Пауза заканчивает текущий этап и прекращает дальнейшую выдачу; отмена не удаляет published.
- [ ] **4. Выполнить реальные failover-тесты:** остановить worker после checkpoint, передать другому; возобновить старый и отвергнуть его результат. При отсутствии online workers задания ждут. У UI видны last heartbeat и последний сохранённый этап. Повтор запроса модели после crash возможен и честно учитывается в usage.
- [ ] **5. Commit:** `feat: add durable leases and multi-device recovery`.

### Task 9: Vercel, домены и повторяемая публикация

**Files:** создать `packages/contracts/src/publication.ts`, `packages/core/src/publication.ts`, `packages/adapters/src/vercel/{client.ts,upload.ts,publish.ts,reconcile.ts,domains.ts}`, `apps/control/src/routes/publication.ts`, `supabase/migrations/003_publication_intents.sql`; тесты `tests/integration/publication.test.ts`, `tests/integration/vercel-contract.test.ts`.

**Interfaces:** `PublicationIntent = {id:string; siteId:string; revisionId:string; manifestHash:string; deploymentId:string|null; phase:PublicationState}`; `PublicationState = 'pending'|'uploading'|'creating'|'checking'|'promoting'|'reconciling'|'waiting_quota'|'awaiting_dns'|'published'|'needs_attention'`. `requestPublication(actor, siteId, revisionId, expectedRevision, requestKey): Promise<PublicationIntent>`; new-site pipeline вызывает внутренний авторизованный эквивалент. `advancePublication(intentId): Promise<PublicationState>`, `getDomainSetup(siteId): Promise<{records: DnsRecord[]; verified:boolean}>`.

- [ ] **1. Написать контрактные тесты транспорта:** upload 200 без JSON; create timeout после фактического создания; promotion 202; второй intent во время unknown; 429; неверный alias target; DNS ещё не готов. Assertions: один найденный deployment переиспользован, новый create не отправлен вслепую, publishedId не сменён до совпадения alias/revision и успешного HTTPS.
- [ ] **2. Запустить** `npm run test:integration -- publication`; сначала failures. Живой `vercel-contract` — отдельный opt-in тест только на выделенном личном демопроекте после настройки учётных данных.
- [ ] **3. Реализовать короткие resumable server steps.** R2 GET → проверка digest → POST /v2/files; затем POST /v13/deployments без target и с meta intent/site/revision, проект Other с пустыми build/install. Vercel token не у worker. PUT в R2 не означает загрузку в Vercel: байты на этом шаге проходят сервер, но не огромным входящим body. API запроса содержит только IDs/manifest, не весь ZIP. Сериализация по сайту и аккаунту, независимый учёт provider request/deployment limits.
- [ ] **4. Проверить REST promotion и восстановление.** POST /v10/projects/{projectId}/promote/{deploymentId}; опрашивать статус и GET /v4/aliases/{alias}, потом HTTPS нужного содержимого. CLI promote не использовать как эквивалент: у него другой build-flow. При неопределённом create искать meta через пагинацию списка deployment; не полагаться на недокументированный Idempotency-Key. Hobby: 1 deployment одновременно, 100 в сутки; quota wait не запускает генерацию заново. DNS записи показывает UI, registrar меняется вручную. При сбое остаётся старая опубликованная версия.
- [ ] **5. Commit:** `feat: add vercel publication reconciliation and domains`.

### Task 10: Импорт пачек и реестр на 5000 записей

**Files:** создать `packages/core/src/import/{rows.ts,csv.ts,xlsx.ts}`, `apps/desktop/src/features/batches/{BatchImport.tsx,BatchTable.tsx,BatchDetail.tsx}`, `apps/control/src/routes/batches.ts`; тесты `packages/core/test/import.test.ts`, `tests/integration/batches.test.ts`, `tests/e2e/batch.spec.ts`.

**Interfaces:** `parseImport(file: {name:string; bytes:Uint8Array}): Promise<{rows: ImportRow[]; issues: RowIssue[]}>`; ImportRow = SiteInput + rowNumber; RowIssue = rowNumber/column/code/message. `submitBatch(actor, validRows, requestKey): Promise<{batchId:string; siteIds:string[]}>`; `pauseBatch|resumeBatch|cancelBatch(actor,batchId): Promise<void>`.

- [ ] **1. Написать тесты:** CSV с quoted commas и BOM, XLSX без исполнения формул/макросов, пустые ячейки, локальное сопоставление logo, дубликаты IDN/ASCII и существующие домены. Проверить отдельно «О сайте» у одной строки; ошибочные строки не теряются при запуске корректных.
- [ ] **2. Запустить** `npm test -- packages/core/test/import.test.ts`, `npm run test:integration -- batches`, затем e2e; ожидать failures.
- [ ] **3. Реализовать parse/preview/submit.** Никакого автоматического скачивания URL из logo. Не принимать повтор запроса как новую пачку, не перезаписывать существующие сайты. Кнопки паузы/продолжения/отмены выполняют серверные операции прав. Cursor pagination и server-side filters; не загружать все 5000 строк в renderer.
- [ ] **4. Прогнать** 100 fake jobs и 5000 записей с 2 workers, ошибками, паузой и продолжением. Assert число уникальных siteId, отсутствие пропусков/повторов страниц при неизменяемом dataset, продолжение остальных jobs после ошибки одной строки. Показать measured timings; не называть это нагрузочным тестом 5000 реальных публикаций.
- [ ] **5. Commit:** `feat: add batch imports and paginated site management`.

### Task 11: Визуальные правки существующих элементов

**Files:** создать `packages/core/src/visual/{html-patch.ts,css-patch.ts,editable-map.ts}`, `apps/desktop/src/features/editor/{VisualEditor.tsx,ElementInspector.tsx,preview-bridge.ts}`; тесты `packages/core/test/visual.test.ts`, `tests/e2e/visual.spec.ts`, `tests/e2e/preview-isolation.spec.ts`.

**Interfaces:** `ElementPatch = {elementId:string; text?:string; href?:string; imageAssetId?:string; styles?:{color?:string;backgroundColor?:string;fontSize?:string;margin?:string;padding?:string}}`; `applyElementPatch(actor, siteId, expectedRevision, patch): Promise<Revision>`. Разрешённый набор значений проверяется; текст не превращается в raw HTML.

- [ ] **1. Написать тесты:** текст с <script> становится текстом; javascript: URL отвергается; меняется только нужный узел; внешние ресурсы и parent navigation не допускаются. После визуальной правки ИИ меняет структуру, сохраняя новый текст. Поддельное message с чужим source/token не вызывает сохранение.
- [ ] **2. Запустить** `npm test -- packages/core/test/visual.test.ts`, `npm run test:e2e -- visual preview-isolation`; ожидать failures.
- [ ] **3. Реализовать HTML/CSS AST patch и отдельный preview.** Стабильные element IDs и sidecar map, запись исходника, без сериализации runtime DOM. Preview iframe с opaque origin, sandbox без allow-same-origin, запрет forms/popups/top-navigation; только собственный nonce bridge, сгенерированные scripts в режиме выделения отключены. Ни одна native capability не доступна этому контексту. Сервисные IDs не раскрывают tenant/account/provider secrets.
- [ ] **4. Проверить выбор, правку и конфликт** на Windows WebView2 и macOS WKWebView; отдельно проверить isolation через custom Rust commands. Если iframe-поведение платформы не даёт требуемой изоляции, использовать внешний Chromium preview с выделением через доверенный драйвер, не ослаблять ACL.
- [ ] **5. Commit:** `feat: add source-preserving visual edits`.

### Task 12: Версии, экспорт и восстановление

**Files:** создать `packages/core/src/{history.ts,retention.ts,backup.ts}`, `apps/control/src/routes/history.ts`, `apps/desktop/src/features/history/VersionHistory.tsx`, `apps/desktop/src/features/settings/BackupSettings.tsx`, `apps/desktop/src/features/files/SourceFiles.tsx`, `docs/operations/recovery.md`; тесты `tests/integration/history.test.ts`, `tests/integration/backup.test.ts`.

**Interfaces:** `rollback(actor, siteId, revisionId, expectedRevision): Promise<PublicationIntent>`; `planCleanup(now): Promise<{deletableManifestIds:string[]}>`; `exportSite(actor, siteId, revisionId): Promise<ExportHandle>`; `createBackup(actor, passphrase): Promise<ExportHandle>`; `restoreBackup(actor, archive, passphrase, target): Promise<RestoreReport>`. `listSourceFiles(actor, siteId, revisionId): Promise<{path:string;size:number}[]>` и `readSourceFile(actor, siteId, revisionId, path): Promise<ArtifactFile>` — только admin, с проверкой пути. SourceFiles показывает дерево, содержимое и скачивание. Backup — версия формата, encrypted metadata+files и hashes; ExportHandle передаёт ограниченный поток/файл через Rust, не мастер-ключ.

- [ ] **1. Написать тесты:** после 8 публикаций остаются current+5 previous; draft, candidate, активный job/intent защищены; rollback создаёт действие в журнале. Неверный пароль, отсутствующий файл или hash mismatch не частично восстанавливают рабочую базу. User/spec-user archive export и source-tree endpoints → FORBIDDEN.
- [ ] **2. Запустить** `npm run test:integration -- history backup`; ожидать failures.
- [ ] **3. Реализовать ретенцию и экспорт.** Сироты удаляются после 24-часового grace period и повторной проверки ссылок; отклонённые кандидаты становятся доступными очистке. Подробные job logs — 30 дней, aggregate usage сохраняется. Rollback проходит общий publication pipeline. ZIP пути проверяются при упаковке и восстановлении.
- [ ] **4. Восстановить один сайт с историей в пустой тестовой среде.** Сначала проверить manifest и создать staging restore, затем переключить записи. В recovery.md описать повторное приглашение Auth-пользователей, привязку stable IDs и перевыпуск worker tokens; сервисные ключи не включать в backup. Проверить локальную независимую копию, отличать её от R2 версии.
- [ ] **5. Commit:** `feat: add revision retention and portable recovery`.

### Task 15: Пакетная передача резервных копий и возобновляемая подготовка восстановления

**Порядок:** дополнительная необходимая задача после независимого gate задачи 12 и перед задачами 13–14. Номер 15 сохраняет прежние номера задач. Она закрывает требование крупной независимой копии из задачи 12; состав продукта и провайдеры не меняются. Основание — аудит маршрутов `NativeArchives`/`PostgresBackup`, сохраняемый в `docs/operations/recovery-transfer-design.md`: старый путь требует по запросу на каждую запись и всю подготовку установки внутри одного запроса. Расчёты с условной задержкой не считаются измерением сети.

**Files:** создать `packages/contracts/src/recovery-transfer.ts`, `apps/worker/src/remote-recovery-transfer.ts`, `apps/control/src/routes/recovery-transfer.ts`, `packages/adapters/src/postgres-recovery-transfer.ts`, `tests/integration/recovery-transfer.test.ts`, `tests/integration/recovery-transfer-fixture.ts`, `apps/worker/test/remote-recovery-transfer.test.ts`, `docs/operations/recovery-transfer-design.md`; изменить `native-archives.ts`, recovery routes и `postgres-backup.ts` для делегирования передачи/подготовки; документацию восстановления. Если нужны durable progress tables, использовать следующую свободную миграцию после финальной задачи 12, исторические 001–008 не менять. Подготовку больших записей можно выделить в `postgres-restore-preparation.ts` по ответственности, сохранив существующие валидаторы и правила установки.

**Interfaces:** сохранить core `createBackup`, `restoreBackup`, `ExportHandle`, `RestoreReport` и приватный native IPC. Контракты определяют `RecoveryTransferPage` (ограниченные части записей/ресурсов, cursor/nextCursor, immutable snapshot/restore binding), `RecoveryPreparationProgress` (phase, prepared/total, cursor, safe error). Приватный серверный порт: `readBatch(actor,id,cursor): Promise<RecoveryTransferPage>`, `stageBatch(actor,id,batch): Promise<RecoveryPreparationProgress>`, `prepareBatch(actor,id): Promise<RecoveryPreparationProgress>`, `commitPrepared(actor,id): Promise<RestoreReport>`; actor разрешается сервером. DTO, retry/cursor semantics и схему progress уточнить в коротком preflight перед кодом против финального task12 API.

- [x] **1. Добавить behavioral regressions.** Builder `tests/integration/recovery-transfer-fixture.ts` переиспользует нормализованный fixture 5000 сайтов × 6 состояний: 900009 expanded metadata records, 270000 physical-file descriptors; размер 13.5 GB остаётся проекцией. Проверить реальную цепочку NativeArchives → control → disposable PostgreSQL: metadata backup reads ≤5000 HTTP calls, metadata restore/stage/preparation ≤20000 calls; отдельная установка выполняет только финальный fenced SQL commit. До commit целевой реестр пуст, после commit сохранены stable IDs/history/evidence/Auth mappings/quarantine, старое хранилище недоступно. Для полного количества файлов допустимы отдельно помеченные маленькие тела; это не benchmark 13.5 GB. Детерминированный latency fixture считает вызовы/ограниченную конкуренцию без реальных sleeps. Прерванный/повторный batch, изменённый replay, пропущенные части, неверный hash, oversized request/response, role loss, expiry и отмена не создают частичный рабочий реестр и не дублируют байты.
- [x] **2. Запустить** `npm test -- apps/worker/test/remote-recovery-transfer.test.ts` и `npm run test:integration -- recovery-transfer`; получить реальные failing assertions старого поведения, не import-error.
- [x] **3. Реализовать ограниченные пакеты.** Remote Node↔control batch: raw bytes ≤1 MiB, encoded JSON ≤2 MiB; ≤256 metadata items либо ≤64 resource parts; фиксированная конкуренция ≤4 суммарно на native transfer runner с backpressure. Крупная одиночная запись использует ограниченные части. Приватные renderer↔Rust↔Node JSON 64 KB/raw24 KB остаются прежними; крупные HTTP-пакеты существуют только внутри доверенного remote adapter. Все массивы/буферы ограничены пакетом, остальное — SQL/disk pages. Сервер выбирает запись/ресурс по авторизованному snapshot/restore ID, не по клиентскому SQL/objectKey/path. Каждая операция проверяет fresh admin и scope. Пакеты записи и complete подтверждаются идемпотентно; курсор/порядок/полнота проверяются сервером.
- [x] **4. Разделить prepare и commit.** Подготовка преобразует и проверяет ограниченную порцию staged records, сохраняет durable progress и повторяется после сетевой неопределённости. Проверка bytes/hashes/closure/Auth mapping завершена до переключения; final commit — короткий existing exclusive transaction в пустой target с fresh authority, без циклов R2/crypto/filesystem. Времена запросов/renewal должны обеспечивать достижимость пути при ограниченной задержке; согласовать bounded operation/pin renewal, expiry/cancel/role-loss cleanup, не выдавать одно увеличение timeout за исправление миллионов вызовов. Не оживлять истёкшие capabilities или tombstoned payloads. Существующие shared/exclusive/session-capture правила сохраняются.
- [x] **5. Проверить формат и провести focused review.** Старые и новые encrypted archives задачи 12 читаются прежним codec; STORE/ZIP64/GCM, metadata1M/768MiB/index192MiB/ZIP1M/48GiB, semantic hashes, secret exclusion, same-adapter restore и quarantine сохраняются. Публичный source ZIP остаётся обычным ZIP. Закрытие/restore-switch дожидается уже запущенного hourly maintenance и всех принадлежащих операции запросов до закрытия persistence; отдельный controlled-delay regression закрывает существующую гонку close/maintenance. Прогресс и ошибки по-русски, passphrase не проходит control HTTP. Прогнать новые unit/real SQL плюс covering existing backup/native/history tests, typecheck/build, задокументировать calls/bytes/observed duration отдельно от условной сети и full-body/provider acceptance. Полные native GUI/live provider тесты остаются задачей 14.
- [x] **6. Commit:** `feat: batch recovery transfers and resume restore preparation`. Независимое task-scoped review до задачи 13; финальные интерфейсы и следующую миграцию передать владельцам 13/14.

### Task 13: Доступность, HTTPS и расход ресурсов

**Files:** создать `apps/worker/src/health/{scheduler.ts,probe.ts}`, `packages/core/src/usage.ts`, `apps/control/src/routes/health.ts`, `apps/desktop/src/features/sites/HealthStatus.tsx`, `apps/desktop/src/features/settings/UsagePanel.tsx`; тесты `tests/integration/health.test.ts`, `packages/core/test/usage.test.ts`.

**Interfaces:** `probeSite(siteId, expectedRevisionId): Promise<{checkedAt:number; status:'ok'|'dns_pending'|'https_error'|'unreachable'|'wrong_version'; detail:string}>`; `scheduleHealth(now): Promise<string[]>`; `UsageEvent = {jobId:string; provider:string; inputTokens:number; outputTokens:number; bytesStored:number; durationMs:number; estimatedCostUsd:number|null}`.

- [ ] **1. Написать тесты:** healthy, NXDOMAIN, certificate error, wrong release, redirect на private IP, DNS rebind и IPv6 loopback. Никогда не отключать TLS validation. Assert расписание 6 часов, отсутствие повторного активного health job, устаревшая проверка видна после offline.
- [ ] **2. Запустить** `npm run test:integration -- health`, `npm test -- packages/core/test/usage.test.ts`; ожидать failures.
- [ ] **3. Реализовать worker-based мониторинг.** Ограничить адреса зарегистрированными доменами, проверять разрешённый IP при соединении и на каждом redirect, не отправлять cookies/ключи. Не выполнять HTTP probe в привилегированном renderer. Выключенные устройства означают stale status, а не выдуманный success.
- [ ] **4. Проверить статистику** retries и incomplete attempts; неизвестная стоимость = null, не 0. Токены/время/объём показывать отдельно от оценки по тарифу. Денежного auto-stop нет. Не выдавать оценку за счёт провайдера и не делать непрерывный polling, удерживающий базу активной.
- [ ] **5. Commit:** `feat: add worker health checks and usage accounting`.

### Task 14: Сборки Windows и macOS и пилот

**Files:** создать `scripts/{prepare-runtime.mjs,prepare-browser.mjs,check-package.mjs}`, `.github/workflows/verify.yml`, `docs/{development.md,pilot-report.md}`; изменить tauri.conf.json, Rust resource resolution, корневой package.json; тест `tests/e2e/pilot.spec.ts`.

**Interfaces:** `npm run verify` = typecheck + unit + integration + build; `npm run package:desktop` собирает конкретный OS target; `npm run pilot -- --fixtures` использует только fake adapters, `--live` требует явно настроенные подключения и выбранные demo domains. Отчёт фиксирует реальные результаты отдельно для каждой платформы и провайдера.

- [ ] **1. Написать package smoke и pilot сценарий:** на чистой машине без Node/npm приложение запускает нужный worker/browser; закрытие панели завершает children; повторный запуск сохраняет сессию/очередь. UI обычного user не запускает unenrolled worker.
- [ ] **2. Запустить fixture pilot** и проверить, что missing runtime/браузер/credentials приводят к понятной ошибке, а не тихому зависанию.
- [ ] **3. Упаковать pinned Node + compiled JS + matching Playwright Chromium** для Windows x64 и macOS arm64/x64. Не использовать Node SEA/pkg как обязательное условие v1. Tauri externalBin/resources, PLAYWRIGHT_BROWSERS_PATH, profiles отдельно в app-data. Обычному клиенту browser не обязателен до включения доверенного worker; для пилота допустим общий полный installer. Проверить WebView2 и вложенные macOS executable/helpers.
- [ ] **4. Прогнать 5–10 личных некоммерческих демосайтов после настройки аккаунтов.** Пять направлений, manual/auto topics, AI edit/refine/reject/publish, visual edit, rollback, два устройства, failover, custom-domain HTTPS и restore. Измерить размер, токены, время и ошибки. Получить визуальную оценку пользователя. Реальные Mac-тесты, подписание/notarization и сервисные integration tests, которые не выполнены, явно остаются незавершёнными; без них не заявлять полную готовность.
- [ ] **5. Commit:** `test: add cross-platform packaging and pilot evidence`.

## Общая проверка и критерии завершения

Команды в плане становятся доступными в соответствующих задачах. Сначала каждый тест должен подтвердить отсутствие нужного поведения, затем пройти после реализации. Не писать проверки, которые лишь повторяют внутренний код; тестировать наблюдаемые результаты и границы доверия. Не запускать повторно весь набор после каждого косметического изменения.

Перед передачей: `npm run verify`, fixture e2e и Windows desktop smoke. Отдельно — PostgreSQL race/RLS, provider contract smoke, macOS package smoke, live pilot. Ошибки среды не подменять успехом mock-тестов. Не выполнять push, публикацию приложения, покупки или включение платных тарифов как побочный эффект проверки.

Каждый commit содержит только файлы завершённой задачи и связанные документы. При параллельной реализации worktrees/ветки должны быть согласованы; интерфейсы изменяются вместе с потребителями. Префикс новых веток — `codex/`.

## Покрытие спецификации

| Требование | Задачи |
|---|---|
| Windows/macOS, русский UI, английские сайты | 3, 4, 14 |
| HTML/CSS/JS, отсутствие форм/лишних функций | 2, 3, 6 |
| 14 референсов, 5 стилей, разнообразие, редкие изображения | 3, 6, 14 |
| Создание и правки через ИИ в первом проходе | 3–6 |
| user/spec-user/admin, свои и назначенные сайты | 1, 5, 7 |
| Файлы admin, private R2, ключи на доверенных устройствах | 2, 6, 7, 12 |
| 2 устройства, очередь, heartbeat, продолжение этапов | 7, 8 |
| CSV/XLSX, пачки 100, 5000 записей | 1, 8, 10 |
| Публикация, DNS, лимиты Hobby, unknown result | 9 |
| Предпросмотр и визуальные правки | 2, 4, 5, 11 |
| История current+5, export, independent backup | 12, 15 |
| HTTPS, availability, usage без денежного cap | 13 |
| Бесплатный личный пилот до покупки услуг | 6, 9, 14 |

## Технические источники

Проверены 26 октября 2026 года; при реализации сверить изменяемые контракты.

- [Responses tool loop](https://developers.openai.com/api/docs/guides/function-calling) и [управление контекстом](https://developers.openai.com/api/docs/guides/conversation-state): сохранять outputs и результаты tools; собственный чат не зависит от срока хранения response у провайдера.
- [Tauri sidecars](https://v2.tauri.app/develop/sidecar/) и [capabilities](https://v2.tauri.app/security/capabilities/): отдельный исполняемый файл и явные permissions для custom commands.
- [Playwright browsers](https://playwright.dev/docs/browsers) и [launch options](https://playwright.dev/docs/api/class-browsertype#browser-type-launch): matching revision и явный chromiumSandbox.
- [Vercel upload](https://vercel.com/docs/rest-api/deployments/upload-deployment-files), [create](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment), [REST promotion](https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-given-deployment), [alias lookup](https://vercel.com/docs/rest-api/aliases/get-an-alias): это разные восстанавливаемые шаги.
- [Vercel Function limits](https://vercel.com/docs/functions/limitations): request/response до 4,5 МБ; не помещать архив сайта в body и не ждать длительную генерацию внутри handler.
- [R2 presigned URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) и [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/): прямой PUT, проверка операции/объекта и conditional requests.
- [Supabase JWT](https://supabase.com/docs/guides/auth/jwts), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [PostgreSQL SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.htm): серверная аутентификация, проверка свежих прав и атомарная выдача.

## Самопроверка плана

Проверены покрытие спецификации, согласованность интерфейсов, тесты пяти рисков, порядок зависимостей и отсутствие покупок в подготовительных шагах. Внешние ключи, DNS и Mac требуются для конкретных интеграционных испытаний; они не мешают этапу A. Продуктовый код и результаты выполнения тестов в этот документ не включены, поскольку реализация ещё не начата.



---

# C. Общие ограничения и инструменты — точный shared context

Источник: `C:/Users/sazur/.codex/visualizations/2026/10/26/01a1777f-1fed-7cf3-9158-96e8e92fe058/site-factory/.superpowers/sdd/2026-10-26-site-factory-implementation/shared-context.md`

# Shared implementation context

Project workdir: C:/Users/sazur/.codex/visualizations/2026/10/26/01a1777f-1fed-7cf3-9158-96e8e92fe058/site-factory
Primary repo: C:/Users/sazur/Desktop/site-factory
Branch: codex/site-factory-pilot
Do not edit C:/Users/sazur/Desktop/speech. Read the task brief before this file. No paid service calls or new accounts are authorized by local testing.

## Global Constraints

Ниже сохранены точные требования архитектуры; они относятся ко всем задачам.

- «Начальный интерфейс панели — на русском; содержимое сайтов — на английском.»
- «Сайты содержат HTML, CSS и небольшой JavaScript без React, Next.js, Vite и других клиентских фреймворков.»
- «Правки через ИИ входят в первую рабочую версию и доступны spec-user и admin для сайтов в их области доступа.»
- «Визуальный редактор — дополнительный способ внести простые правки; он не обязателен для работы с ИИ.»
- «Для каждого сайта одновременно допускается одна операция изменения или публикации.»
- «Предлагаемые значения аренды задания — 120 секунд, продление каждые 30 секунд.» Эти значения приняты вместе с архитектурой.
- «Начальные технические значения: два одновременных задания на рабочее устройство; максимум две попытки исправления по результатам проверки; до трёх повторов временной сетевой ошибки с задержкой.»
- «Денежный потолок генерации не вводится.»
- «Предлагаемый срок истории — текущая опубликованная версия и пять предыдущих опубликованных состояний, плюс текущий черновик.»
- «Первая публикация нового сайта происходит автоматически после проверки.»
- «Кнопка „Опубликовать“ публикует принятый и проверенный черновик.»
- «Проверки включают валидные внутренние пути, отсутствие форм и запрещённых внешних запросов, отсутствие секретов и очевидных заглушек, работающие ссылки, читаемость, отсутствие горизонтального переполнения на ширинах 375 и 1440 пикселей.»
- «Картинки редки: предлагаемое значение по умолчанию — вероятность 10% и максимум одна тематическая иллюстрация на сайт.»
- «Если все рабочие устройства выключены, новые сайты не генерируются; уже опубликованные продолжают обслуживаться хостингом.»

Технические решения этого плана: один npm workspace; фиксированные версии зависимостей в lockfile; отдельные сборки Windows x64 и macOS arm64/x64. Для текущей версии Playwright целевые системы пилота — Windows 11+ и macOS 14+; более старые ОС не объявлять поддержанными без отдельной проверки. Локальный демонстрационный режим явно обозначен и не считается проверкой облачной синхронизации или реальной модели. Node, Rust и npm уже доступны на текущем Windows-устройстве; Mac ещё нужен для фактической проверки. Версии и системные требования проверяются при закреплении зависимостей.


## Общие интерфейсы

Определить в задаче 1 в `packages/contracts/src/model.ts`; последующие задачи расширяют типы в явно названных файлах. ID — строки UUID, время — целое число миллисекунд UTC.

- `Role = 'user' | 'spec-user' | 'admin'`.
- `Principal = {userId: string; role: Role}`; роль разрешается сервером, не берётся из request body.
- `SiteInput = {domain: string; about?: string; referenceId?: string; logoAssetId?: string}`.
- `Site = {id: string; domain: string; ownerId: string; assignedUserIds: string[]; input: SiteInput; revision: number; draftId: string | null; publishedId: string | null; generationStatus: string; domainStatus: string}`.
- `Revision = {id: string; siteId: string; parentId: string | null; manifestId: string; kind: 'draft' | 'candidate' | 'published'; createdAt: number}`.
- `ArtifactFile = {path: string; bytes: Uint8Array; mediaType: string}`.
- `Manifest = {id: string; siteId: string; files: {path: string; objectKey: string; size: number; sha256: string; sha1: string; mediaType: string}[]; templateVersion: string; createdAt: number}`.
- `Job = {id: string; siteId: string; kind: 'generate' | 'edit'; stage: string; state: 'queued' | 'running' | 'paused' | 'waiting_provider' | 'needs_attention' | 'completed' | 'cancelled'; checkpointId: string | null; baseRevision: number}`.
- `Lease = {jobId: string; workerId: string; generation: number; expiresAt: number}`.
- `ValidationReport = {ok: boolean; issues: {code: string; path?: string; message: string}[]; screenshotIds: string[]}`.
- `AppError.code`: `INVALID_INPUT`, `DUPLICATE_DOMAIN`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `STALE_LEASE`, `PROVIDER_WAIT`, `NEEDS_ATTENTION`.
- `Clock.now(): number`, `IdSource.next(): string`. Тесты не используют реальные задержки.
- `SiteRepository.create(input, principal): Promise<Site>`, `get(id): Promise<Site | null>`, `list(principal, cursor?, limit?): Promise<{items: Site[]; nextCursor: string | null}>`, `compareAndSet(siteId, expectedRevision, patch): Promise<Site>`.
- `ArtifactStore.put(siteId, files, templateVersion): Promise<Manifest>`, `read(manifestId): Promise<ArtifactFile[]>`.
- `Checkpoint = {id:string; jobId:string; stage:string; manifestId:string|null; stateKey:string; createdAt:number}`; `CheckpointStore.save(job: Job, lease: Lease, state: Record<string, unknown>, files: ArtifactFile[]): Promise<Checkpoint>` сохраняет private metadata и файлы до изменения очереди.
- `Queue.enqueue(job): Promise<void>`, `claim(workerId): Promise<{job: Job; lease: Lease} | null>`, `heartbeat(lease): Promise<Lease>`, `checkpoint(lease: Lease, checkpoint: Checkpoint): Promise<void>`, `finish(lease, state): Promise<void>`.
- `PublicationState = 'pending'|'uploading'|'creating'|'checking'|'promoting'|'reconciling'|'waiting_quota'|'awaiting_dns'|'published'|'needs_attention'`.
- `ModelPort.run(request: ModelRequest, tools: FileTools, signal: AbortSignal): Promise<ModelResult>`. `ModelRequest` и `ModelResult` определяются в задаче 3.
- `PublicationPort.advance(intentId: string): Promise<PublicationState>`; PublicationState определён выше, расширенный intent и реальный адаптер — задача 9, локальный fake — задача 3.

Служебные DTO должны быть сериализуемыми: байты через транспорт передаются ресурсами/pipe, не помещаются в обычные JSON-запросы к Vercel Function. Проверка схем выполняется на каждой границе доверия.

## Rulings
- Ruling: Work in linked worktree C:/Users/sazur/.codex/visualizations/2026/10/26/01a1777f-1fed-7cf3-9158-96e8e92fe058/site-factory, branch codex/site-factory-pilot, primary repo C:/Users/sazur/Desktop/site-factory — source files are writable here and Take Control remains untouched. Native create_worktree is bound to the unrelated speech repository and cannot select the new repository, so native Git fallback was used. Cost if wrong: relocate checkout; no product design change.
- Ruling: Existing approved architecture and user's latest message authorize execution of all 14 tasks with subagents. Do not request approval between tasks. Only credentials/real platform tests and consequential external actions can require human input after independent work is complete.
- Ruling: Initial repository has documentation only; no baseline test suite or dependencies yet. Do not report absent tests as passing.
- Ruling: Plan RED wording that expects missing modules is setup evidence, not behavioral TDD evidence. Establish minimal typed skeletons and executable tests, observe actual failing assertions, then implement behavior. No artificial tests for inert configuration. Cost if wrong: a small additional setup step.
- Ruling: Common signatures are contracts, but definitions whose inputs are assigned to later tasks may be introduced with that producer, not as broken forward imports in Task 1. FileTools is shared type; implementation belongs to worker. Keep contracts independent of apps. Cost if wrong: type-only refactoring.
- Ruling: ReferenceLibrary.tsx is specified in Task 3 before React exists. Task 3 delivers catalog APIs and data; Task 4 integrates this screen. Admin remote mutation wiring completes with Task 7. No functional scope removed.
- Ruling: Tests shown with fixture variables in plan require concrete fixtures/builders in each task; literal incomplete snippets are not ready-to-run tests.
- Ruling: The branch is not complete without the promised native/cloud acceptance evidence. Missing Mac or credentials is recorded explicitly while all runnable code and local tests continue.

- Ruling: Task 3 extends CheckpointStore with trusted load(checkpointId), returning checkpoint/private state/files; pipeline verifies job/site ownership and validates restored state. Job.generation may optionally freeze seed/styleId/templateVersion via trusted catalog.prepare; fallback selections persist before assets/model and cannot change on retry, catalog disable, or template update. Missing pinned version fails clearly. Persist archive manifest and deterministic publication intent before any publication call; Task 9 adds real intent storage/wiring. WorkerDeps may inject catalog/workspace/validator in addition to required ports. Reason: saved stages must actually be reloadable and stable without app-to-contract imports. Cost if wrong: type-only orchestration refactoring; no external account side effect.

- Ruling: Task 3 introduces immutable RevisionRepository {put,get} and a local adapter, injected as WorkerDeps.revisions. Site.draftId/publishedId always reference Revision.id, not Manifest.id; resolve Revision.manifestId for file access. Persist the intended publication revision identity/metadata with archive and intent before provider calls, register the published revision only after provider reports published, then CAS Site; identical put is idempotent for crash recovery. For edit jobs, archive validated candidate files/private checkpoint without mutating Site pointers/revision or publishing; Task 5 owns registration/accept/reject. Reason: plan omitted revision persistence and direct draft installation would violate approved candidate acceptance. Cost if wrong: additive port adapter refactoring; no change to product flow.

- Ruling: Task 5 may publish the accepted immutable Revision itself, keeping draftId/publishedId equal when that accepted version is public. Revision.kind records provenance and is not sufficient proof of publication. Successful publication must have durable site/revision/manifest intent-outcome evidence; Task 9/12 build actual publication history from successful outcomes and initial-generation publication, never from kind alone. Pending/failed intents do not count. Reason: preserve immutable revision identity while keeping accepted/published pointer semantics coherent. Cost if wrong: publication-history adapter refactoring; website bytes unaffected.

- Ruling for Task 6: keep transport/checkpoint DTOs serializable. Add optional plain versioned continuation to ModelRequest/ModelResult and an optional fourth ModelPort.run argument (ModelRunHooks with awaited checkpoint callback) for internal worker integration; do not place a function in serialized ModelRequest. Existing three-argument FakeModel/callers remain compatible. Bind replay to operation/instruction/base/model, persist provider output before tools and completed call output together with matching file bytes before the next call. One retry owner must prevent adapter and pipeline retries multiplying the maximum. Reason: resumable provider loops need mid-run persistence while preserving DTO boundaries. Cost if wrong: small additive port refactoring; no API/account action.

## Provider recovery decision
- Ruling for Task6 fix: add a trusted durable provider-recovery ticket to Job/queue retry, bound to exact failed checkpoint, new operation identity and configured model. Only explicit Retry after classified account/configuration rejection creates it; settings save alone never resumes. Pipeline consumes under lease, preserves current files/completed tool effects and cumulative usage, archives previous continuation privately and checkpoints recovery before HTTP. Same-model recovery may preserve full replay/results; changed-model recovery starts provider history from current files and retains previous opaque replay only privately. Refusal, ambiguous image and exhausted transient states cannot use this path. An optional trusted ModelPort recovery helper is acceptable; no user-supplied ticket/role/secret fields. Reason: corrected credentials/model/quota must recover without losing work or reopening unrelated terminal states; durable ticket survives restart. Cost if wrong: additive queue/port refinement, carried to SQL Task8.

## Visual editor decision
- Ruling for Task11: explicit visual Save validates source-preserving patches, archives an immutable Revision and installs it as current draft through expectedRevision CAS, returning that installed Revision; it never publishes and needs no second AI-candidate accept click. Internal candidate staging may reuse existing evidence/acceptance. Bind editable map to exact base manifest/source hash and reject stale maps. Reason: approved interface returns Revision and user is explicitly saving a manual patch; preserve publication separation. Cost if wrong: UI orchestration adjustment, no source loss.

## Cloud boundary decisions
- Ruling for Task7: introduce validated safe HTTP DTOs and an explicit demo/remote client facade. Never expose full Job.edit, private checkpoint state or master credentials in UI summaries; add UNAUTHENTICATED/401 rather than disguising session expiry. Remote errors must not fall back to demo. Reason: current trusted local DTOs are not a remote authorization boundary. Cost if wrong: additive contract refactoring.
- Ruling for Task7/8: add durable upload_preparations and checkpoints records and an injected LeaseAuthority that fails closed until real SQL authority exists. Server chooses immutable keys and checks authenticated worker/current job/generation with server time at prepare and completion. Task8 supplies full lease lifecycle; managed worker mutations remain explicitly unavailable until wired, while authorized registry/auth/admin operations may run. Presigned URL expiry alone is not one-use; use signed conditional PUT plus never-reused keys. Reason: staged delivery must not introduce permissive temporary security. Cost if wrong: a small adapter/API seam revision.
- Ruling for Task7: cloud editing must use durable per-site operation admission and short SQL/CAS transactions, not only process-local serial() or a transaction held over network/model calls. Prefer normalized records in the declared tables rather than one shared growing JSON journal. SQL adapter may use a server-only PostgreSQL driver with injected connection/pool, so real transaction/RLS tests exercise actual PostgreSQL. If the existing EditingStore contract prevents correct short transactions, propose the smallest additive seam before coding. Reason: multiple API instances and later workers require durable exclusion. Cost if wrong: adapter refactoring.
- Ruling for Task7: one shared installation with one current application membership role per user; no speculative multi-tenancy. First admin is provisioned by an explicit deployment/bootstrap step tied to a verified Auth user, never by first public signup. Admin invitation uses retryable safe identity/membership reconciliation. Browser preview authorization uses scoped short-lived capability or authenticated blob fetch, never bearer tokens/master Vercel bypass secrets in URLs. Reason: fill omitted bootstrap and browser boundaries without changing role design. Cost if wrong: deployment/client adjustment.

- Ruling for Task7 editing: reuse createEditing through a site-scoped normalized SQL EditingStore and admission-bound repositories/queue; do not implement a second acceptance/evidence/recovery state machine. A durable controller admission serializes cross-call mutation and every SQL write/CAS/enqueue rechecks its current token/expiry in a short transaction; no transaction spans R2. Transfer admission to the queued job atomically with enqueue, and release only if still controller-owned. While an active worker/controller owns the site, GET chat/list/preview can return authorized read-only projections of last durable state plus job status without invoking mutating recovery or stealing admission; reconcile through existing core once admission is available. Keep read projection duplication limited to mapping, not domain transitions. Controller admission expiry/recovery must be bounded and stale callers fenced. Reason: reuse reviewed invariants while making multi-instance ownership durable and keeping polling available. Cost if wrong: small core/scoped-adapter refactor; no provider effects.

- Ruling for Task7 native managed access: allow HTTPS in main CSP connect-src, retaining current local IPC rules and all script/frame/object restrictions. Managed Auth/control origins are explicitly configured by user; client binds token-bearing requests to validated configured origins and does not forward bearer credentials to arbitrary preview/signed-asset URLs. No script/img/frame wildcard expansion. Add narrow main-local-only open_remote_preview for validated HTTPS preview route/capability, using fixed OS opener API/arguments without shell; preserve existing local preview behavior. Test native URL/schema/ACL denial and actual browser capability→cookie→asset flow, including cross-site navigation/SameSite handling; native GUI execution remains Task14. Reason: arbitrary deployments cannot be build-time pinned, and packaged managed login/preview must have working transports. Cost if wrong: CSP/origin/opener refactor; no secret is returned to renderer and no actual browser/native approval retry is authorized here.

- Ruling for Task7 invitation completion: implement concrete server-only Supabase provider, durable send-attempt/identity binding and no automatic resend after unknown outcome. Explicit admin Retry may bind an exact-email confirmed identity verified by privileged Admin GET, as an independently authorized existing recipient; unconfirmed/ambiguous identities remain pending without membership and without trusting metadata/invited_at. Current password-only Login cannot accept a new invitation, so add minimal invite-code verification + password setup in Login, using official supported API and documented email template, in-memory session/cleared secrets/no signup or fallback. Reason: admin invitation plus usable desktop login is Task7 scope, and unavailable credentials do not excuse missing adapter/onboarding code. Cost if wrong: small Auth adapter/UI adjustment; no actual email/account action.

- Ruling: Task7 follow-up added002_invitation_attempts.sql; Task8 queue migration uses003_queue_leases.sql instead of brief002_queue_leases.sql. Later migration filenames use next unused numeric prefix, never duplicate versions. This is an approved filename-only plan adjustment.

## Tooling
- On Windows, filtered SQL runs use the direct Node integration script: `& 'C:/Program Files/nodejs/node.exe' 'scripts/test-integration.mjs' ... -t '^(?!.*actual900009)'`. Do not route caret-containing filters through npm.cmd/cmd.exe: it can consume the caret and inadvertently run the heavy full-volume fixture. Unfiltered npm.cmd commands remain fine when the full suite is intentional. Use task-specific artifact/progress filenames so later capacity runs cannot overwrite historical proof.
- Set CARGO_TARGET_DIR explicitly to the active checkout's .local-state/cargo-target for every Cargo command. The host's inherited value points to an unrelated C:/speech-vulkan-ninja cache; do not use or clean it.
Node C:/Program Files/nodejs/node.exe; npm.cmd; Git C:/Program Files/Git/cmd/git.exe; Rust in C:/Users/sazur/.cargo/bin. Use npm.cmd in PowerShell. Need network or Git metadata mutation outside sandbox? Use exec_command require_escalated with a narrowly scoped reason, inspect result, and report denial. Never print secrets. Do not disable sandbox or protections. Pin dependency versions and keep a lockfile.



---

# D. Task14 — окончательный отчёт реализации

Источник: `C:/Users/sazur/.codex/visualizations/2026/10/26/01a1777f-1fed-7cf3-9158-96e8e92fe058/site-factory/.superpowers/sdd/2026-10-26-site-factory-implementation/task-14-report.md`

# Task14 implementation report

Implementation and all runnable local gates completed. The one frozen unfiltered verifier exited0; full fixture E2E, fixture pilot, Windows release/NSIS and extracted-installer early headless diagnostics passed. Actual supported Windows11/nativeGUI/WebView2/OS-store, macOS14 install/run/sign/notary, live providers/domains and two physical devices remain pending acceptance. No native GUI approval retry, real credential access, provider mutation, push or merge occurred. Independent Task14 review belongs to ROOT and has not been replaced by self-review.

BASE e45e55df4c5cf4cd83d28d2d75332f9a6f47b573, initially clean. Controller production GO received for this same owner; sole implementer, no helper/reviewer. Workdir is the linked site-factory checkout; speech remains untouched. Approved preflight deltas/anchor/Mac-helper/disk rulings remain binding. Actual native GUI approval is not retried; no credentials, live services/accounts, email/DNS/deployment/purchase, push or merge.

## Package boundary RED/GREEN

The boundary log below is chronological; final sections supersede earlier in-progress checkpoint wording.

- `node --test scripts/test/package-runtime.test.mjs` first hit child-spawn EPERM (environment, no product RED). Direct `C:/Program Files/nodejs/node.exe scripts/test/package-runtime.test.mjs` executes builtin node:test without subprocess isolation: four actual assertion failures for adjacent manifest replacement, corrupt/extra/missing inventory, wrong PE/Mach-O target, emitted module closure. Implementation then GREEN4/4,66.50ms tests.
- Direct Node `scripts/test/package-download.test.mjs`: initial3 failures (contained bytes absent, escaping symlink accepted, offline missing/corrupt cache accepted); after bounded safe extraction/cache implementation GREEN3/3,26.14ms tests. No test guard increase.
- Official HTTPS HEAD for exact Node24.21.0 SHASUMS and Chromium156.0.8078.4 win64 returned200. Controlled preparation fetched official Node sums and browser archives; `scripts/runtime-sources.lock.json` records exact URLs/digests/trust provenance. Browser self-hash is explicitly controlled TLS retrieval, not a published upstream signature. Installed Node reportsv24.21.0.
- `node scripts/prepare-runtime.mjs --target win32-x64 --record-source`: exit0,85 emitted modules/19 locked vendor packages, preserved ESM paths. Node archive SHA256158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541 from official sums.
- `node scripts/prepare-browser.mjs --target win32-x64 --record-source`: exit0; Chromium+headless1248, ffmpeg1013, winldd1007 prepared. Full distributions retained.
- Read-only measured after Windows staging: free7,767,998,464B; stage875,467,147B, verified compressed cache370,310,712B. This is below the2GiB additional preparation cap and keeps the2GiB free floor. Existing native cache/current binaries retained.

Native lifecycle, compiled-anchor verification, fixture pilot and final gates remain in progress. No platform/live-provider/clean-machine success is claimed from these component results.

## Native/lifecycle component boundaries

- Focused bootstrap initially hit ordinary Vite-helper spawn EPERM; narrow authorized test rerun observed2 actual RED assertions (runtime admitted before grant; EOF resolved). Implemented fixed bounded private `SF_NATIVE_START_V1` grant before dynamic runtime import; GREEN2/2. Rust sends the grant only after successful Windows kill-on-close Job attachment.
- Rust package tests observed2 actual REDs (missing runtime prevented controller construction; adjacent manifest replacement accepted). Lazy controller, safe Russian recoverable startup error, expected compiled digest/target/format and full inventory verification yield GREEN2/2. One interim Rust syntax error was corrected before compilation; not behavioral evidence.
- Pure browser launch tests RED2 then GREEN2/2: fixed Mac owner proxy chosen, no provider/proxy environment, missing owner capability fails closed. Validation/preview/selection share this seam. Combined bootstrap/browser launch GREEN4/4.
- Root approved exact private proxy/direct-child group anchor ownership refinement in task-14-mac-ownership-ruling.md. Separate helper ownership/unsafe override tests RED3 then GREEN3/3. Actual helper source `cargo check --offline` succeeded for both aarch64-apple-darwin and x86_64-apple-darwin using installed target std libraries. This checks code/types only; no Mac linking, FD/process execution or platform acceptance.
- Main Rust full `cargo test --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --lib`:22PASS/1existing ignored synthetic OS-store roundtrip (23total),2.55s tests; all fixed/native schema/ACL/private-pipe tests pass without GUI or real OS-store access. Every Cargo command sets checkout target, trusted test Node, incremental0/debug0. Main SHA256 and helper libc/serde dependencies reuse cached pinned versions; no dependency installation.
- Intermediate `typecheck` caught browser LaunchOptions.env possibly undefined; strengthened the shared helper's return contract. Fresh typecheck/build passed. Lazy infrequent feature chunks reduce initial JS to248.84kB; Login247.71kB; all chunks<500kB, no threshold increase or advisory suppression.
- Deferred restore detector now observes actual state body reads by verified SHA256, with a deliberate positive control while remap is held and a real post-release read assertion. Added same-revision/new-outcome stale-read/completion/due-claim SQL coverage. Initial focused SQL selected3files:8PASS/1fixture-caption failure (`healthy` vs actual safe `ok`); corrected that expectation. Focused rerun remains pending.
- Finalized Windows runtime check:2276files/877637371B, expected manifest SHA256a4c8eaaeb1e6cb660df2d409d819b93dec8083b3170b86e6c290160fd04f0e87. The Node download checksum above authenticates the archive; extracted Node has its own manifest file hash. Early non-GUI package diagnostics use a synthetic private root and explicit memory-only secrets; no native startup/chooser bypass.
- Windows release build active in exec27750, source frozen for that build. Latest observed free5362618368B, Cargo logical6166244540B including built runtime resource copy; free space remains above2GiB floor and native growth below3GiB cap. One new dead-code warning for old eager Worker::new is recorded for narrow cleanup after first build result. No duplicate build or heavy test.

## Packaged production path corrections and installer boundary

- First release compile completed7m36s, but NSIS could not read a long source path. Exact existing8.3 source alias is now compared by realpath and full manifest digest against the checked runtime; relative runtime destinations remain intact. No flattening, subst or global state.
- Capturing an early GUI-subsystem executable directly in PowerShell did not wait and is not smoke evidence. Actual waiting Node spawnSync captured exit1: NODE_ENV=production correctly denied the generic local demonstration adapter, revealing a missing trusted native persistence seam. Controller approved an internal process-local permit from verified native bootstrap, branding only actual native DB handles. Default/caller/env/renderer/archive/serialized permit and ordinary injected DB handles remain denied. Verified local restore carries the real handle scope in memory only.
- Focused production initialization/edit/independent encrypted restore/quarantined restart plus native recovery/bootstrap:3files/7PASS,12.45s; tsc --noEmit exit0. Positive case generated a synthetic site, accepted an edit and preserved draft through restore/restart under production. Interim fixture mistakes (wrong LocalBackup property and candidate state/status field) were corrected; they were not new product failures.
- Windows real descendant component test uses actual bootstrap, Job attachment before grant, detached child and retained process wait handle. Job close signals descendant termination within5s. Full Rust lib suite23PASS/1existing ignored OS-store case,2.57s tests. Initial new fixture corrections handled canonical Windows extended paths and valid Job exit0; no GUI/OS-store/Win11 inference.
- Official mac arm64/x64 Node and browser archives were retrieved serially and expected SHA256 recorded. Offline archive inspection passed target headers for Node, Chromium17Mach-O components per Mac target, shell5 and ffmpeg1; original executable modes/notices checked for launchable components. This inspects archive bytes without claiming extracted Mac layout, linking, signatures or runtime behavior. A first notice matcher missed official Chrome ABOUT, and an overbroad mode assertion treated a non-executable dylib as an executable; corrected to actual notices and MH_EXECUTE/launch paths.
- Isolated official7-Zip26.05 Alone2/7zz source compiled with existing MSVC x64. Official URL/archive hashes, local build hash and recipe are in scripts/package-tools.lock.json. Standalone7za lacks NSIS; this full inspector includes NSIS. No global install or installer execution; controlled TLS provenance is not an upstream signature claim.
- Second release compilation GREEN1m35s, NSIS built452.96MiB. Early native smoke then failed clearly on restart. Exact inventory comparison found only a new zero-byte Playwright DEPENDENCIES_VALIDATED marker in the actual release resource root. The staged2277-file manifest and native compiled digest matched; Playwright's pinned coreBundle34979–34995 writes the30day host-validation cache on default registry launch. This is a valid product RED, not a resource verification relaxation.
- Narrow supported executablePath now selects exact bundled Windows shell/full Chrome in the shared validation/preview/selection seam. No skip-host-validation flag, marker allowlist/seeding, vendor patch, sandbox/default-argument weakening, ambient/PATH fallback or executable override. Pure selector RED (undefined)→GREEN3/3. Native missing DLL/launch failures still fail. Controller approved pre-bundle smoke: build --no-bundle→native synthetic generation/restart→both binaries headless/inventory checks→bundle. Only the verified owned zero-byte marker was moved outside runtime to an evidence filename after child cleanup.
- Measured after all archives/tools: cache1093477754B + Windows stage878179935B =1971657689B retained preparation, under2GiB. Inspector/tool phase70341223B; Cargo6334373009B (growth2554870910B from initial3779502099B, under3GiB). Free4247244800B before second build; observed NSIS minimum2881855488B; free3887394816B after compression temporaries released. No cache/user/current-app binary deletion. Third warm build is active in exec52151; no duplicate heavy verification.

## Final implementation and binding

Production source adds exact target preparation/check/finalization, matching-host packaging/CI, native compiled resource verification and contained lifecycle, plus a fixture pilot/evidence procedure. New docs are docs/development.md and docs/pilot-report.md. Scripts preserve emitted ESM rather than adding a JS bundler/SEA. The final reachable tree includes stdio/bootstrap, monitoring/activity/health, archive transfer/preparation/maintenance and browser preview/selection modules, plus complete locked production vendor packages. Unresolved/nonliteral workspace imports fail; vendor optional features use locked target compatibility rather than pulling unrelated Electron/dev dependencies. Node binary and full browser distributions/notices, Rust reachable dependency notices, five templates and14references are inventoried.

Main native compiles exact finalized manifest SHA256/target/format. Helpers are finalized first, main is outside inventory, and release has no mutable expected-value override or adjacent self-anchor. Source lock digests are archive digests; extracted Node/browser files have distinct per-file hashes. Node expected checksums came from official HTTPS sums; browser expected hashes came from controlled official TLS retrieval with final URL/time/bytes recorded. No upstream browser signature/PKI claim. Local artifacts are unsigned/ad-hoc; replacement of the whole unsigned main executable lies outside the resource anchor guarantee.

Release resolves only fixed resource Node/ESM/browser paths and fixes NODE_ENV=production; no PATH/ambient browser cache/download-on-client fallback. Two health siblings, activity/heartbeat, archive/maintenance/request/browser drain stay on reviewed Task13/15 interfaces. Node↔control2MiB JSON/raw1MiB batches remain separate from native64k request/24k resource DTOs. Restored schema9/010 catalog data is private persisted data and never an executable resource source. Private native persistence permit and DB handle branding do not serialize into restored data or alter role/enrollment/model authorization.

Windows Job attachment precedes bootstrap release, and actual detached-descendant termination was measured. Mac uses the approved fixed authenticated proxy/direct anchor mechanism: descriptor1/2/3/4 transfer; fd5 direct same-helper parent authentication; bounded safe arguments/environment; no model/worker credentials or liveness-FD leaks; retained unreaped anchor until group cleanup; proxy failure and watchdog/parent EOF both own cleanup. No arbitrary PID/group/executable/profile public broker, vendor patch or sandbox disabling. Pure ordering tests/type checks are not actual Mac lifecycle proof.

Mac-only supported macOS.files maps the whole directory into Contents/Resources/runtime with generic resources empty. Pinned Tauri2.12.2 Settings.copy_resources delegates walked entries to fs_utils::copy_file/fs::copy; the supported custom directory mapping uses copy_dir's explicit symlink branch. Generated configuration tests cover both Mac targets and unchanged Windows relative mapping. Fixed helper ad-hoc finalization precedes manifest, and post-app inventory is checked after outer bundling. Tauri's pinned outer signing path has no deep Resources re-sign; genuine publisher signing/notarization remains a separate future gate. No Mac staged tree, linking, sign or execution was inferred from source inspection.

## Final Windows artifacts and independent extraction

- Third build exec52151 exit0: release1m35s, NSIS452.99MiB. Early synthetic native generation/restart and both bundled browser selectors ran before bundling. Full Chrome was deliberately exercised headlessly, preserving the headful acceptance gap. Both report156.0.8078.4; inventory is exact after each disposal and native restart. Native smoke reports bundledNode/bundledHeadlessBrowser/generation completed/restartPreservedSite/unenrolledManagedDenied, memory-only credentials, gui:false/platformAcceptance:false.
- Final runtime2277files/877643103B; manifest SHA256 `8915e53f934d9951f1ae43d8b8807b4f5174475e057cb7cba979ad99b65b11b1`. Usable retained layout `.local-state/cargo-target/x86_64-pc-windows-msvc/release/{site-factory-desktop.exe,runtime/}`. Portable main SHA256 `2553ac6b3dc33c665c056b78a2b8fecd04c4be52f0329553e51a9beea1972240`.
- Installer `.local-state/cargo-target/x86_64-pc-windows-msvc/release/bundle/nsis/Site Factory_0.1.0_x64-setup.exe`,474989857B, SHA256 `6ae5a7b4a73f49cd07ea7dbae307ff83adce0c06e7f9a3183b523d41ee996bcf`. Exact read-only listing2286entries/1102785526B; installer+one extraction1577775383B<1.5GiB. WebView2 offline installer is present as an installer payload, not executed.
- Initial extraction guard correctly rejected portable/installed main hash mismatch. Investigation found ONLY the exact Tauri fixed first marker UNK→NSS,3bytes at7264194. Pinned tauri-cli-v2.12.2 crates/tauri-bundler/src/bundle.rs35–89,124–135,195–201 patches before NSIS and restores original afterward. Expected installed bytes are derived from the already checked original through this exact first-token transformation, with bounds/old-token/count1 and full expected SHA comparison. Installed main SHA256 `97d78d174abd2e4bf2fc265f8a81ac9cd8c963cdb712a71a5734c4e369a74b34`. No arbitrary difference/offset allowance or recompression was used.
- `node scripts/inspect-windows-installer.mjs --installer <above>` final exec32356 exit0: exact extracted runtime inventory/compiled anchor, native generation/restart, resource+adjacent-manifest replacement rejected, missing browser rejected, exact repair/recovery passed. `.local-state/package/win32-x64/installer-inspection.json` retains whole evidence, with installerExecuted:false/gui:false/cleanWin11Acceptance:false. The generated installer was never launched. The temporary extraction tree was retired only after proof and no children; final installer/current release remain.

## Fixture pilot, visual scope and deferred findings

- `node scripts/pilot.mjs --fixtures` exec84986 exit0:14E2E PASS35.8s,17SQL PASS22.73s across5files,70226msoverall. `.local-state/pilot/run.json` explicitly marks realProviders/twoPhysicalDevices/fullProjectedBodies/platformAcceptance false. Five direction JSONs and*-1440.png/*-375.png remain in that directory. Manual/automatic subjects alternate; demo token counters0/0 are synthetic, durations partial, full bytes/image/cost unknown. docs/pilot-report.md records each actual known subtotal and UI elapsed time.
- Required full fixture E2E through new narrow launcher: `node scripts/test-e2e.mjs`, exec76254 chain,27/27PASS1.3m. Covers create, AI refine/reject/accept/explicit publish, visual Save, registry/batch/admin/managed/monitoring/recovery screens, rollback/history and preview isolation. The pilot PNGs capture the displayed preview modal: selected source naturalWidth1440/375 is separately asserted; actual PNG1086×681/376×898 shows clipping/shaded panel. They are not standalone full-page/nativeGUI proof. ROOT inspected all five desktop directions and representative mobile images; user visual approval remains pending. Editorial375 long-word break remains a quality observation without template scope expansion.
- Pending invitation `.local-state/managed-invite-pending-viewport.png` is actual1280×800 viewport, scroll0/fullPage:false. ROOT inspected it. No nativeGUI inspection retried.
- Historical pilot warning at node7764 remains in `.local-state/task14-pilot.log`. Pinned Playwright workers force FORCE_COLOR=1; test-e2e entrypoint selects that policy and removes contradictory NO_COLOR only there. Other launchers honor NO_COLOR by removing FORCE_COLOR. No warning handler/global suppression or vendor patch. Final full E2E and verify logs have no color warning. Git still emits LF→CRLF working-copy notices; diff check has no whitespace error, and no global Git setting was changed to hide them.
- Lazy infrequent React screens split initial248.84kB/Login247.71kB, all chunks below unchanged500kB warning threshold. No raised size limit. Deferred Task15 early state-body-read barrier detector now has real SHA-bound GET observation plus a deliberate positive control; Task13 same-revision/new-outcome SQL regression exercises stale read/completion and immediate due claim. Pilot/final SQL gates pass these fixes. No unrelated deferred-index rewrite.
- Deliberate negative `node scripts/pilot.mjs --live` without config exits1 with explicit-config/no-discovery guidance. No live account execution. Configured live mode is honestly account/domain preflight only; actual5–10personal sites/provider actions/platform/two physical devices still need the concrete authorized environment.

## Frozen normal verification and post-gate delta

One unfiltered `SITE_FACTORY_TEST_EVIDENCE_PREFIX=task14-final-20261029; npm.cmd run verify`, exec42308, exited0. Source frozen at2026-10-29T07:13:23.458Z,360Git-visible files; `.local-state/task14-final-source-manifest.json` SHA256 `e0d11894476952b1c89e737d6b0395e90342cedeb9bd2213a0b73d0c7a221d38`. After exit every file hash matched with changes:[] in `.local-state/task14-frozen-source-check.json`; full log `.local-state/task14-verify.log` SHA256 `75d4f8b163f9ca1d6bc3a65a0b9fa03f7ce32501fb224144d86ca608a610a4af`.

1. tsc --noEmit exit0.
2. Unit45files:417PASS/2existing SKIP419total,238.90s. Explicit maxWorkers1 retains all guards/cases/in-file races; historical default-worker failures remain failures, not relabeled.
3. Builtin package tests6PASS83.63ms and safe download/extraction3PASS26.16ms.
4. Full unfiltered disposable SQL19files:120PASS/3existing SKIP123total,1312.80s. Dedicated cluster/spool cleaned; no services adopted, no extra DB/spool polling. No repeated940k run.
5. TypeScript emission and Vite104modules exit0,184ms; no chunk advisory/color warning.

Actual final transport `.local-state/task14-final-20261029-transfer-5000.json`:940009source records/270000physical descriptors,940022restored including catalog,544759302Bsmall metadata/222187605Bsmall bodies. Inventory SHA256 `d14eee9514497e7f390df8b78d0e6de5af09aa668f2a33f4a8e74f93779f62a8`;3681backup metadata/session/other calls;15304restore calls (3672metadata,4219resources,7381prepare,27session,4other,1commit),maxinflight2,maxrequest683675B/maxresponse683822B. Whole1061749.7016ms, whole commit request44422.78ms. Restored30000activity rows/partial time/tokens, health unverified and all operation markers cleared; physical knownBytes222187605 while total bytes/cost remainnull. This begins after trusted encrypted extraction; it is not full13.5GB/48GiB archive/cipher/live-provider throughput or a claim every commit transaction is<15s.

Separate metadata-only capacity `.local-state/task14-full-volume.json`:940009records/546796380Bcaptured,62635.6269ms capture/helper32062.4787ms,167714952Bindex160chunks/940169planned ZIP members/120001protected roots. `.local-state/task14-closure-measured.json`:22910.1248ms plan+collect,7346.8435ms max measured exclusive fence. Raw projected13500000000Bbody was not read/transferred by that metadata case.

Historical filename oversight: transport honored the explicit Task14 prefix, but unchanged retention-capacity hardcoded two Task13 output paths. The run overwrote original task13-full-volume.json (old quoted values remain in Task13 report/ROOT ledger; raw original no longer at that path). Original closure JSON was preserved before overwrite as `.local-state/task13-reviewed-closure-before-task14.json`, SHA256 `4eaffc73c7f819adaf98c89e933360571d3c99f7bf7b0debd8bee0e6e77188e4`. Current raw outputs were copied exactly to Task14 names: full-volume SHA256 `c1d5bab9b6fe567b6d22a60357bd9e5cdbc96528c412511b2a0e0cec1c5a51e9`,closure `a58e83694047a861c92ffaa8189a7dc9ab2af50438518b9a0633e8b7ab2b3b04`.

AFTER the frozen gate, controller approved only a fixture output-prefix refinement: new tests/integration/evidence.ts shared validation; recovery-transfer uses it with its same recovery timestamp fallback; retention-capacity uses explicit env prefix with compatible task13 default. No production/SQL/DTO/assertion/timeout change. Direct Node helper check passed legacy default, explicit task prefix and traversal rejection without capacity/database execution; fresh tsc --noEmit exit0. Evidence docs followed. No new full-capacity pass is claimed for this post-gate filename delta. Final source/delta fingerprints are recorded below after documentation completion.

## Disk evidence and exact ownership retirements

Disk measurements are samples, not a continuous minimum/peak trace. Initial preparation stayed<2GiB retained, native growth<3GiB, installer+one extraction<1.5GiB. Warm selected Node binary/LICENSE extraction and unchanged verified-byte reuse avoided a redundant Node/npm tree; short source alias did not alter destinations. All native commands used checkout target/test Node/incremental0/debug0. No pre-task cache, user data/current-app binary deletion or other workspace access.

Controller-approved first retirement after proof/pilot/no owned children: exactly six new Task14 release dependency/build/fingerprint directories (logical1519295531B; all births after05:57:43Z), one owned extracted installer tree, and duplicate Windows staged runtime. Stage exact manifest/hash/mode inventory matched kept release/runtime and its manifest was saved as `.local-state/task14-staged-runtime-manifest.json` with `.local-state/task14-staged-runtime-proof.json`. Before/after JSON and detailed file inventory remain. First UTC creation guard refused safely before deletion (local-vs-UTC comparison); fixed UTC→UTC, rechecked exact absolute contained non-reparse roots and no children. Actual free2735194112→6135005184B,3399811072Breclaimed; logical/hardlink totals differ. Pre-task debug/registry/download caches and usable release/runtime/main/installer were kept. Future release rebuild recompiles these generated dependencies (~first7m36s) and restages.

Full gate's final pre-start free6046597120B gave677888000B beyond the initial3GiBworking+2GiBfloor estimate. That working estimate was insufficient as a blanket reservation. During prepare, sampled free2384809984B/237326336Bfloor margin triggered ROOT's exact new-only Mac archive retirement ruling:8files/723167042B, births06:28:39–06:29:07Z, lock hashes reverified; native LiteralPath file removal, before/after JSON retained. Free sample2445066240→3168247808B while fixture writes continued; no isolated reclaim-rate claim. During commit sampled2380091392B was still above floor. ROOT then approved5new Windows compressed archives370310712B; by its actual pre-delete sample commit cleanup had already released storage (5745741824→6115700736B), so this second retirement did not prove avoidance of the commit floor. All source URLs/hashes/provenance and header/mode/notices proof remain; future exact verified redownload totals~1.09GB. Inspector binary/source archives/recipe remain. No broad cleanup or fixture/guard change occurred.

Post-full cleanup free7121907712B. Recommend a fresh full-gate planning budget≥8GiB free AFTER retained build outputs (5GiBworking+2GiBfloor+1GiBcontingency), remeasured per phase; this is conservative planning from observed phases, not a measured maximum. Avoiding disk-full by approved new-only regeneration tradeoffs does not turn source/capacity/platform acceptance into a mock pass.

## Self-review, limitations and handoff

Self-review found/fixed actual source-layout/production-constructor/immutable-marker/NSIS-byte-binding/Mac-symlink-copy seams, and reviewed containment ordering, descriptor/env isolation, persisted-data/executable separation and default-deny handle provenance. Behavioral tests and final guards above pass. No external reviewer/helper was spawned; ROOT performs the independent full14 gate and later whole-branch review.

Actual Win11 clean installation without Node/npm, WebView2/native windows/choosers/ACL/credential stores and parent-crash matrix; macOS14 arm64/x64 link/package/install/FD-group execution; real publisher signing/notarization; live Supabase/Auth/R2/Vercel/OpenAI/DNS/HTTPS; two physical devices; real5–10domain pilot/user visual approval; full projected13.5GB/48GiB bodies remain unchecked. These are explicit acceptance gaps, not excuses for missing independent code. Fixtures/source inspection/Win10 compile do not establish them. Configured live CLI does not create accounts or perform live actions.

Final361-file source manifest `.local-state/task14-postgate-source-manifest.json` SHA256 `f2c8d66ca16518060d0bb62c72a6f102f9de5aa87fecde485cd62c435405f880`; `.local-state/task14-postgate-delta.json` confirms exactly docs/development.md,docs/pilot-report.md,tests/integration/evidence.ts,recovery-transfer.test.ts,retention-capacity.test.ts differ from the passing360-file boundary, with0production files changed. Direct prefix/default/traversal check and fresh typecheck passed. Current free sample7121723392B. Staged diff check exit0 (normal LF→CRLF notices retained).

Scoped commit `b218336086716e3004e815f009479a83bd4aea71` — `test: add cross-platform packaging and pilot evidence`;63files,2777insertions/86deletions. `git status --short` empty after commit. SDD scratch/report remains in the established ignored report location, not accidentally staged with production. No push/merge/publication. Ready for ROOT's independent fullTask14 gate against original BASEe45e55df4c5cf4cd83d28d2d75332f9a6f47b573.


---

# E. Task14 — независимое ревью и открытый I1

Источник: `C:/Users/sazur/.codex/visualizations/2026/10/26/01a1777f-1fed-7cf3-9158-96e8e92fe058/site-factory/.superpowers/sdd/2026-10-26-site-factory-implementation/task-14-review.md`

# Task 14 independent review

## Spec Compliance

- ❌ Issues found: the Mac owner socket depends on the length of the complete app-data path and rejects a normal long temporary root used by its own package smoke (I1). The approved manifest's source-commit provenance is also absent (M1). All specifically listed Task14 files have corresponding changes in the supplied package; the ordinary pinned Node/preserved ESM design, three explicit targets, fixture/live distinction, and independent compiled anchor are implemented.
- ⚠️ Full platform/live acceptance remains unverified as enumerated below. The report correctly leaves these gates open; their absence is separate from the source defect in I1.

## Strengths

- The main executable obtains its expected manifest digest from the trusted build input, enforces the target/version, and refuses an unanchored release build. Runtime verification compares that compiled value before walking the exact contained inventory; changing an adjacent manifest cannot select a new expected value (`apps/desktop/src-tauri/build.rs:10`, `apps/desktop/src-tauri/build.rs:23`, `apps/desktop/src-tauri/src/runtime_package.rs:35`, `apps/desktop/src-tauri/src/runtime_package.rs:63`). Main is outside the resource inventory, avoiding the self-hash cycle.
- The release launcher clears ambient environment, fixes production/resource-derived runtime and browser paths, and releases the fixed bootstrap grant only after Windows Job attachment (`apps/desktop/src-tauri/src/worker.rs:190`, `apps/desktop/src-tauri/src/worker.rs:224`, `apps/desktop/src-tauri/src/worker.rs:254`, `apps/desktop/src-tauri/src/worker.rs:267`). The real Windows descendant test retains a process handle and observes termination rather than relying on a reused numeric PID (`apps/desktop/src-tauri/src/worker.rs:1005`).
- Validation, preview and selection share fixed resource browser selectors, retaining `chromiumSandbox:true` and a scrubbed environment. Both Windows selectors use supported `executablePath`, avoiding Playwright's mutable registry marker; no marker allowlist or validation-disabling switch is introduced (`apps/worker/src/browser-launch.ts:4`, `apps/worker/src/validation/browser.ts:39`, `apps/worker/src/desktop-runtime.ts:486`, `apps/worker/src/preview/selection.ts:45`). Windows smoke checks inventory after browser disposal and restart (`scripts/package-desktop.mjs:51`, `scripts/smoke-runtime-browsers.mjs:10`).
- Mac ownership retains an unreaped direct anchor, transfers only the four Playwright descriptors, authenticates the fixed helper peer, grants GO after ownership registration, and cleans the real browser group when the proxy or owner channel dies (`apps/desktop/runtime-guard/src/macos.rs:169`, `apps/desktop/runtime-guard/src/macos.rs:204`, `apps/desktop/runtime-guard/src/macos.rs:267`, `apps/desktop/runtime-guard/src/macos.rs:380`, `apps/desktop/runtime-guard/src/macos.rs:391`, `apps/desktop/runtime-guard/src/macos.rs:427`). The Mac configuration uses the symlink-preserving directory mapping, finalizes the helper before the manifest, and checks post-bundle inventory (`scripts/lib/package-native.mjs:2`, `scripts/package-desktop.mjs:18`, `scripts/package-desktop.mjs:60`). This is source assurance, not a real Mac execution result.
- Production local persistence remains denied by default. The permit and actual DB handles use process-local WeakSets; forged/serialized flags cannot brand a database, and verified local restore carries real source-handle provenance in memory (`packages/adapters/src/native-persistence.ts:3`, `packages/adapters/src/local-database.ts:16`, `packages/adapters/src/local-database.ts:19`, `packages/adapters/src/local-state.ts:13`, `packages/adapters/src/local-backup.ts:155`). Positive and negative production/edit/restore regressions exercise the boundary (`apps/worker/test/native-production.test.ts:13`, `apps/worker/test/native-production.test.ts:24`).
- Archive preparation verifies locked digests before extraction, rejects traversal/case collisions/escaping links, and keeps the official Node checksum trust source separate from recorded browser TLS provenance (`scripts/lib/package-download.mjs:26`, `scripts/lib/package-download.mjs:58`, `scripts/lib/package-download.mjs:76`, `scripts/runtime-sources.lock.json:11`). Verification fixes the one-worker unit budget while preserving cases/timeouts, forwards integration directly through Node, and serializes phases (`scripts/test-unit.mjs:2`, `scripts/verify.mjs:3`, `scripts/pilot.mjs:20`).
- The prior test debt receives meaningful assertions: restore observes actual SHA-bound state body reads with a positive control, and health coverage changes the settled outcome while retaining the revision (`tests/integration/backup.test.ts:194`, `tests/integration/backup.test.ts:210`, `tests/integration/health.test.ts:35`). Lazy screens address the bundle advisory without raising the threshold (`apps/desktop/src/App.tsx:17`, `docs/pilot-report.md:24`).

## Issues

### Critical (Must Fix)

- None found.

### Important (Should Fix)

#### I1 — Mac ownership socket fails under ordinary long data/temp paths

- `apps/desktop/runtime-guard/src/macos.rs:481` canonicalizes the entire data directory, then `:489–491` appends `.guard-<12hex>.sock` there and returns an error if the absolute path exceeds 100 bytes. This makes every data root longer than 75 bytes unusable. The native smoke itself constructs `temp_dir()/site-factory-package-smoke-<19digit nanos>` (`apps/desktop/src-tauri/src/worker.rs:500–507`), and the Mac packaging command unconditionally runs that smoke (`scripts/package-desktop.mjs:62–63`).
- A representative macOS temporary parent `/var/folders/ab/012345678901234567890123456789/T` is 48 bytes. The smoke directory is another 47 bytes including its separator; the socket becomes 120 bytes, before any `/private` canonical expansion. The guard consequently fails before Node/browser startup. A long ordinary account/app-data path has the same failure. This is a deterministic source defect in the matching-host packaging/startup path, independent of unavailable Mac acceptance evidence.
- Allocate the owner socket beneath a short, securely created owner-only private directory (with the same fixed-helper/token authentication and owned cleanup), while leaving database/profile paths under app-data. Cover a deliberately long data root and the normal smoke-root shape without weakening the AF_UNIX length bound or accepting arbitrary socket selectors. Actual Mac FD/process execution still needs its separate matching-host gate.

### Minor (Nice to Have)

#### M1 — Manifest omits the approved source revision provenance

- `scripts/finalize-runtime.mjs:13` supplies target, signature and the two lock digests to `inventoryRuntime`; `scripts/lib/package-runtime.mjs:38` adds versions and file inventory, but neither records the source commit required by the approved preflight. The per-file hashes protect installed bytes, so this does not break the compiled integrity anchor. It does prevent a retained installer/manifest from identifying the exact reviewed source revision without a separate scratch report. Record the source revision and, when packaging an intentionally dirty tree, an explicit dirty/source fingerprint rather than implying a clean revision.

#### M2 — Component smoke can resolve dependencies from checkout ancestors

- `scripts/lib/package-runtime.mjs:69` calls `workspaceClosure`, whose bare-import handling at `:98` only collects package names; it does not resolve/validate the staged vendor graph. The native smoke runs resource modules located below the checkout (`scripts/package-desktop.mjs:36`, `:52`), and installer inspection also extracts below `.local-state` (`scripts/inspect-windows-installer.mjs:18`, `:29`). Changing the process working directory to a temporary data root does not prevent Node's module-relative ancestor `node_modules` lookup.
- The recursive vendor copier is a substantial safeguard, and no missing dependency in the current artifact was established. This is a verification limitation: an omitted vendor package could still be found in the development checkout and make these smokes pass. Resolve every required staged package within the runtime root and/or run the extracted artifact from a controlled tree with no checkout dependency ancestor. Keep clean-machine acceptance distinct until it is exercised.

## Cannot Verify

1. **Supported Windows acceptance:** actual Windows11 installation without system Node/npm, WebView2/native UI/chooser/ACL/OS-store behavior, and the full window-close/timeout/parent-crash matrix remain open. The report's Windows10 Job/CLI/extracted-artifact evidence is useful component evidence only (`docs/pilot-report.md:7–9`, `task-14-report.md:58–62`, `task-14-report.md:105`).
2. **Mac execution:** both Mac14 architectures still need real extraction/link/package/install, post-launch/restart link/mode/hash inventory, FD3/4 browser transport, proxy/watchdog/owner failure cleanup, and headful behavior. Archive-header checks, cross-target `cargo check`, configuration tests and the pure Ownership state tests do not establish these observations (`apps/desktop/runtime-guard/src/lib.rs:113`, `scripts/package-desktop.mjs:60–63`, `docs/pilot-report.md:10`). I1 must be fixed independently.
3. **Publisher trust:** unsigned/ad-hoc artifacts do not prove Authenticode, Mac publisher signing, notarization or stapling. Resource anchors do not authenticate replacement of the whole unsigned main executable (`docs/development.md:37–39`, `docs/pilot-report.md:11`).
4. **Real provider/live pilot:** actual configured Auth/Supabase/R2/Vercel/OpenAI contracts, invitations/refresh/private storage/DNS/custom HTTPS and 5–10 personal noncommercial sites remain open. The configured `--live` branch is expressly a preflight and performs no provider run (`scripts/pilot.mjs:6–13`, `docs/pilot-report.md:15–22`). No authorization for those actions was inferred.
5. **Physical devices and visual approval:** SQL/logical-worker failover and browser screenshots cannot establish two physical devices or the user's visual approval. The preview images' clipping/source-width distinction is correctly disclosed (`tests/e2e/pilot.spec.ts:14–18`, `docs/pilot-report.md:34`).
6. **Full-body/provider capacity:** the reported 940009-record/270000-descriptor transport moves 222187605B of small bodies after trusted extraction, not projected 13.5GB/48GiB cipher/full-body/live-provider throughput. The 44.4s commit also does not prove a sub-15s commit envelope everywhere (`task-14-report.md:83–85`, `docs/pilot-report.md:42`).
7. **Continuous disk peak and historical raw proof:** saved before/after/hash records support the exact owned retirements and kept release identity, but sampled free-space values cannot prove the continuous minimum. Windows archive retirement followed commit cleanup and cannot be credited with preventing that floor. The overwritten original Task13 full-volume JSON cannot be recovered from its current path; the original closure copy and historical quoted report remain distinct (`task-14-report.md:87`, `:95–99`, `docs/pilot-report.md:44`).

## Review Boundary and Checks

- Read the requested brief, complete shared Global Constraints/Tooling, acceptance handoff, all preflight deltas, Mac ownership ruling, native-persistence ruling, final report and reviewer method. Read the entire supplied 4,311-line BASE `e45e55df4c5cf4cd83d28d2d75332f9a6f47b573` → HEAD `b218336086716e3004e815f009479a83bd4aea71` package once in bounded chunks. Recovered only the visibly truncated 12-line documentation span; no changed-source requery or Git command.
- Named cross-module risk **EOF/restore selection could omit sibling work or retarget executable resources**: checked only the unchanged `runner.ts` sibling join, `desktop-runtime.ts:523–543` drain, `native-archives.ts:131–135` cancellation/request drain and restore-owner exemption, and `local-root.ts:4–12` validated restored-catalog selection. The inspected close path awaits managed stop, pumping, maintenance, archives, admitted work/requests and browser/selection shutdown before the database closes. Resource executable paths remain selected independently by native configuration/browser-launch; the restored catalog does not select executable code. Actual failure timings remain platform acceptance.
- Named evidence risk **retirement or post-gate changes could invalidate the kept artifact/source boundary**: read the stage/kept manifest proof, frozen-source check, post-gate delta, and exact initial/Mac/Windows retirement before/after JSON. Their saved paths, birth times, archive lock hashes and kept manifest/main/installer identities are consistent with the final report's narrow claims. No retrospective full-volume execution or recreation of missing historical proof occurred.
- Focused execution only: read-only Node `path.posix.join` calculation for I1 returned `{temporaryBytes:48, smokeNameBytes:46, dataBytes:95, socketNameBytes:24, socketBytes:120, guardLimit:100}`. No suite, capacity fixture, build, installer, native GUI, credential/provider action, Git mutation, or subagent was run. Checkout/index/HEAD/branch were untouched; this requested review file is the only write.
- The reported frozen gate is 417 unit passes/2 existing skips, 120 SQL passes/3 existing skips, 9 package tests and typecheck/emission/build. I did not replay it. The saved frozen source check reports zero changed files; the post-gate delta lists only two docs, the test evidence-prefix helper and its two fixture consumers, with zero production changes. Earlier default-worker failures and historical color/line-ending notices were not reclassified as passes. The final report documents the color-policy/lazy-feature fixes and retains the remaining Git LF→CRLF notices (`task-14-report.md:69–70`, `:75–89`, `:107`).

## Assessment

**Task quality: Needs fixes.**

The task implements the requested resource, trust, lifecycle and evidence separation with substantial targeted coverage. I1 blocks reliable Mac startup/package smoke for normal long temporary roots and must be corrected before this task gate passes; the listed external acceptance remains explicitly unfinished. Counts: **0 Critical, 1 Important, 2 Minor, 7 CannotVerify**.


---

# F. Mac process ownership — утверждённое техническое решение

Источник: `C:/Users/sazur/.codex/visualizations/2026/10/26/01a1777f-1fed-7cf3-9158-96e8e92fe058/site-factory/.superpowers/sdd/2026-10-26-site-factory-implementation/task-14-mac-ownership-ruling.md`

# Approved Mac browser ownership refinement

Implement the already approved no-stale-PGID containment rule with a fixed private Playwright proxy and a watchdog-owned direct anchor child. This is a bounded native helper split, not a vendor patch or a general process broker.

The watchdog spawns and retains the unreaped direct Child/group before GO. It does not reap/try_wait before group cleanup and signals only that still-owned group. The proxy authenticates over owner-only IPC and transfers exactly Playwright fd1/2/3/4 plus bounded trusted Chrome arguments. Preserve default arguments, pipes and chromiumSandbox; reject sandbox-disabling/unsafe overrides. No public PID/executable/profile selector, inherited model/worker credentials or liveness-FD leaks. Helper modes do not initialize Tauri or credential access.

Proxy death or Playwright killing its proxy must trigger cleanup of the REAL browser anchor/group. Watchdog hard death or owner-pipe EOF must make the anchor terminate its own still-owned group; cleanup cannot depend solely on the watchdog surviving. Retain the anchor until cleanup acknowledgement, then reap/unregister safely. Never retry a stale PID/PGID signal.

Add pure/CLI ordering checks before GO, after GO and while browser work is active, including owner/proxy/watchdog failures. Actual macOS14 descendant cleanup remains pending matching-host acceptance.

Reason: remembering a Playwright descendant PID after Node may reap it does not preserve ownership against PID reuse. Cost: a small native helper-role split and targeted lifecycle tests; no new product scope or human approval gate.


---

# G. Native persistence и NSIS source path — утверждённое решение

Источник: `C:/Users/sazur/.codex/visualizations/2026/10/26/01a1777f-1fed-7cf3-9158-96e8e92fe058/site-factory/.superpowers/sdd/2026-10-26-site-factory-implementation/task-14-native-persistence-ruling.md`

# Approved native-private persistence scope

Task14 Ruling: preserve production local-adapter denial by default while enabling an INTERNAL native-private persistence scope only from trusted createDesktopRuntime(native:true)/verified bootstrap. Brand/tag the returned DB handle; editing store accepts only an injected native-private handle, not ordinary/dev DB or renderer/config/archive/env claims. Preserve fixed NODE_ENV=production, explicit demo/smoke and all remote/enrollment/role/model semantics. Verified local restore staging/root activation inherits handle scope in memory, never serialized authority. Production-mode negative/default/override/unbranded and positive native/editing/independentrestore regressions required. Reason: actual packaged no-GUI smoke exposed unconditional demo-adapter guard blocking legitimate desktop initialization. Cost: small typed internal authority seam with explicit caller provenance; no new user-visible fallback or server-mode bypass.

The actual captured package-smoke exit1 is RED evidence. Verify the affected native/local/packaged paths after the fix; no whole940k rerun solely for this guard repair. No native GUI or OS credential action is authorized by these tests.

NSIS source-path remedy: an existing8.3 alias may be used after confirming canonical identity with the checked runtime tree. Keep relative runtime destinations, inventory paths/hash/modes and resource bytes unchanged. No flattening, subst, global installation or source move. Inspect the resulting artifact through the already approved read-only extraction path.


---

# H. Исторические Minor для итогового ревью

Источник: `C:/Users/sazur/.codex/visualizations/2026/10/26/01a1777f-1fed-7cf3-9158-96e8e92fe058/site-factory/.superpowers/sdd/2026-10-26-site-factory-implementation/final-review-deferred-index.md`

# Deferred findings index for the final whole-branch review

These are historical Minor items, not current confirmed defects. Inspect final source/task13–14 reports before deciding disposition. Source entries are in progress.md at the indicated task labels; original review files carry precise lines. Do not reopen completed task gates or rerun their suites merely because an item is indexed.

- Task1: corrupt-state test rejected savedAt before exercising invalid site/duplicate identity; local process ownership uses resolve rather than realpath (junction aliases).
- Task2: readability selector body * misses direct body text.
- Task4: Russian registry plural count. First-load failure/empty distinction and touched App/runtime/CSS formatting were addressed in reviewedTask5; retain that disposition unless final source regresses.
- Task5: persistent chat refinement relationship/label, handed toTask11 touched UI; verify final disposition.
- Task7: compressed SQL/DTO modules; calibrate actual final maintainability, no size-only finding on unchanged source.
- Task8: raw English stage/state values in WorkerList. Historical revocation test proved post-revocation rejection, NOT observed overlapping contender lock wait; only expiry barrier was observed. Reports must preserve this distinction unless later tests supply the missing evidence.
- Task9: generic catch loses classified safe publication attention reason; Task13 owns allowlisted diagnostic code/action/time/retryability while preserving unknown-result reservations/reconciliation/fairness.
- Task10: duplicate local prepare completion lacks state fence, existing serialized stdio prevented demonstrated concurrent UI reachability. Read task-10-review.md and final ownership/drain changes before classifying.
- Tasks6–12: inherited NO_COLOR/FORCE_COLOR warning, LF/CRLF notices, growing main chunk advisory (Task15 latest561.33kB). Task14 owns narrow launcher normalization/lazy feature splitting; retain actual warnings until fixed.
- Task7 visual QA: full-page pending invitation screenshot had sticky/sidebar scroll stitching artifact; actual viewport check rather than inferring native layout defect.

Actual Win11/WebView2, macOS14 arm64/x64 install/headful/descendant cleanup, signing/notarization, credential-store integration, live Supabase/R2/Vercel/DNS/HTTPS and two physical devices are external acceptance gaps ownedTask14. Existing pure/native mocks/headless/synthetic failover do not prove them. Same-adapter encrypted independent backup is approved v1; cross-adapter migration is separate. Full900k encrypted-member/13.5GB-body benchmark was never claimed by small-body transport/metadatainstallation evidence.

Initial branch BASE for final broad review is2b2fbefec0f6879fb36bec36c83cd755d1979812. Read the skill final-review reference when every task has completed, rather than treating this index as the review itself. Preserve accidentally trackedTask1 scratch report before any mandated final workspace cleanup; no blind clean/delete.
Task15 review M1: tests/integration/backup.test.ts:200/:207 earlyState detector compares bulk query parameter array directly with sourceStateKey string, making this particular assertion unreachable. Other restore/load assertions remain meaningful. Triage actual checkpoint-state read/barrier in final source; do not route a Minor into Task15 fix loop. Task15 M2 reiterates561.33kB advisory assigned14.
Task13 M1 coverage: tests/integration/health.test.ts:40–45 changes revision but not same-revision/new settled outcome. Code compares outcome correctly; add focused SQL sameRevision/newOutcome stale-read, stale-completion and due-claim regression during final14/final triage. Task13 M2 reiterates570.42kB/NO_COLOR warnings; default-worker failures stay separate from409worker1 proof.
Task14 M1: scripts/finalize-runtime.mjs:13 andlib/package-runtime.mjs:38 lack approved source revision/explicitdirtyfingerprint provenance in manifest; independentcompiledresourceintegrityotherwiseworks. Finalreviewtriagesourceidentityrecording.
Task14 M2: lib/package-runtime.mjs:69/:98 bare vendor imports are collected but not containment-resolved; portable/extractedsmokesundercheckoutcouldfindomittedvendorinancestor node_modules. Noactualmissingpackageestablished; finalreviewtriagestageddependencygraphresolution/isolatedcopyverification, retaincleanmachinegap. TheseMinorsareoutside14I1fixloop.


---

# I. Подготовленный запрос итогового whole-branch review

Источник: `C:/Users/sazur/.codex/visualizations/2026/10/26/01a1777f-1fed-7cf3-9158-96e8e92fe058/site-factory/.superpowers/sdd/2026-10-26-site-factory-implementation/final-review-request.md`

# Final whole-branch review dispatch preparation

The controller will supply final HEAD and one full branch diff package only after all task gates. Initial BASE is 2b2fbefec0f6879fb36bec36c83cd755d1979812. Do not dispatch this review early or duplicate Task14 review.

You are the one independent broad reviewer. Use C:/Users/sazur/.codex/skills/requesting-code-review/code-reviewer.md. Read the approved spec docs/superpowers/specs/2026-10-26-site-factory-design.md, plan docs/superpowers/plans/2026-10-26-site-factory-implementation.md, shared-context.md verbatim constraints/tooling, final-review-deferred-index.md, final Task14 report/review and any scoped rereview. Read the complete supplied branch diff once in bounded chunks. Read named source outside the package only to resolve a concrete risk, explaining that reason; do not rederive the whole diff, crawl files indiscriminately or replay completed task reviews/suites. Do not spawn subagents. Read-only checkout/index/HEAD/branch; write only the requested scratch report. No production fixes or Git mutations.

The product is a Russian Tauri desktop panel for Windows/macOS, English static HTML/CSS/small-JS sites, manual and automatic IT/crypto topics, batches/CSV/XLSX and assigned-site roles. User runs conveyor, spec-user edits/accepts/publishes assigned sites, admin manages settings/files. Compare source with the binding spec, including initial validated automatic publication versus explicit candidate acceptance/draft Save and subsequent Publish, retries/resumability, leases, publication unknown-result reservations, enrollment/key boundaries, scoped read-only DTOs, visual sandbox/AST edits, protected current+five/draft/active history, independent encrypted backup and quarantined restore, safe health/usage reporting. A reasonable user's expectation remains relevant when the spec is silent.

Evaluate the final cross-module architecture, concurrency/authorization/data ownership, failure recovery, bounded installation-volume behavior, package execution/integrity/lifecycle, tests and operational documentation. Controller technical rulings are evidence to inspect, not correctness waivers. Task14 Mac ownership and native-persistence ruling docs describe subtle trust and lifetime requirements; final Task13/15 reports distinguish earlier full-capacity evidence from later narrowly tested source deltas. Schema9 with header-aware8 compatibility, separate executable resources versus restored app-data, unchanged native64kJSON/24kraw IPC versus trusted2MiB remote transport, fresh authority and no network/files/crypto inside exclusive database fences remain binding.

Triage every historical Minor/parked entry in final-review-deferred-index.md against actual final source; state resolved/open/disposition rather than assuming historical severity/current defect. Report any behavior you considered and set aside with reason (Declined to judge), plus CannotVerify items and precise evidence owner. Actual clean Win11/WebView2/macOS14 arm64/x64 install/headful/chooser/credential/sign/notary, live configured Supabase/R2/Vercel/OpenAI/DNS/HTTPS and two physical devices may be unfinished acceptance; synthetic/headless/local SQL/cross-check evidence is not a substitute. Judge any remaining runnable code gap independently. No13.5GB full-body, maximum encrypted archive or live5000-publication claim follows from the940009 small-body fixture.

Do not rerun documented suites, builds or heavy capacity fixtures. Focused execution is allowed only to resolve a named unanswered correctness doubt, retaining original guards and resource safety. No native GUI/chooser/credential discovery, account/email/DNS/provider/deploy/purchase/installer execution/push/merge actions. Workdir must be the Site Factory worktree, never unrelated speech. All actual Cargo uses the private .local-state/cargo-target, not inherited external cache. Filtered SQL uses direct Node scripts/test-integration.mjs, not npm.cmd which strips caret anchors on Windows. Explicit one-worker unit launcher preserves in-file concurrency and historical default-worker failures.

Write final-review.md with both spec and quality assessment; line-cited strengths; Critical/Important/Minor findings with trigger, impact and fix; historical-item dispositions; Declined to judge; CannotVerify; and Ready to merge Yes/No/With fixes with reasoning. Return only verdict/counts/report path. Root will read the whole report and, if needed, dispatch one complete final fix wave followed by exactly one scoped rereview.


---

# J. План сохранения доказательств перед eventual SDD cleanup

Источник: `C:/Users/sazur/.codex/visualizations/2026/10/26/01a1777f-1fed-7cf3-9158-96e8e92fe058/site-factory/.superpowers/sdd/2026-10-26-site-factory-implementation/finishing-evidence-plan.md`

# Evidence preservation before eventual SDD cleanup

Do this AFTER Task14 independent gate and any fixes, before the broad final review; do not mutate HEAD while its current reviewer is running. Root owns documentation/orchestration only, never production fixes.

Preserve all plan-local Markdown reports/reviews/briefs/rulings/ledger in a compact tracked archive such as docs/implementation-evidence/2026-10-26-records.zip, plus a human-readable README and exhaustive verbatim Ruling-line decision record in ledger order (explain later corrections supersede provisional bounds). Binary archive avoids adding hundreds of duplicated historical source snippets to the broad review package. Verify its complete entry set and every uncompressed entry SHA256 against original Markdown, save an inventory. Keep actual current docs/pilot-report.md and docs/development.md readable and unchanged except any necessary final evidence updates. Historical Task13 raw full-volume loss/quoted source boundary must remain explicit; do not reconstruct old raw proof.

Exactly one tracked SDD path exists: .superpowers/sdd/2026-10-26-site-factory-implementation/task-1-report.md. A hash-matched copy already exists in .local-state/completed-task-evidence and must be in the verified archive. Remove that old path from Git tracking only after verified archive preservation; leave original ignored scratch file on disk until actual final cleanup. Use a small documentation-only commit, narrow Git metadata escalation as needed; do not mix production edits or merge/push. Whole-branch final review uses initialBASE2b2fbefec0f6879fb36bec36c83cd755d1979812 through the resulting HEAD.

After final broad review and its at-most-one complete fix wave/scoped rereview, refresh archive/decision record with final reports and ALL ledger Ruling lines before any workspace removal. Documentation-only evidence refresh does not invent new code-gate results. Preserve kept release/runtime/installer and .local-state measured evidence, and the worktree/branch. To remove ONLY this plan's SDD scratch, resolve/check exact absolute containment and verified archive completeness first; native PowerShell LiteralPath only, no broad recursive clean or other plan directories. Do not leave the formerly tracked Task1 path deleted-but-uncommitted. No native GUI/provider/credential/live-account actions.


---

# K. Все строки Ruling из журнала — точная запись решений

Сохранены дословно в порядке строк журнала. Поздние явные исправления заменяют прежние предварительные ограничения. Ранние строки не всегда отдельно формулируют цену ошибки; причина и последствия последующих решений раскрыты в handoff и технических приложениях. Это историческая запись, а не основание повторить уже выполненные очистки или тесты.

- Строка журнала 135: - Ruling: Work in linked worktree C:/Users/sazur/.codex/visualizations/2026/10/26/01a1777f-1fed-7cf3-9158-96e8e92fe058/site-factory, branch codex/site-factory-pilot, primary repo C:/Users/sazur/Desktop/site-factory — source files are writable here and Take Control remains untouched. Native create_worktree is bound to the unrelated speech repository and cannot select the new repository, so native Git fallback was used. Cost if wrong: relocate checkout; no product design change.

- Строка журнала 136: - Ruling: Existing approved architecture and user's latest message authorize execution of all 14 tasks with subagents. Do not request approval between tasks. Only credentials/real platform tests and consequential external actions can require human input after independent work is complete.

- Строка журнала 137: - Ruling: Initial repository has documentation only; no baseline test suite or dependencies yet. Do not report absent tests as passing.

- Строка журнала 138: - Ruling: Plan RED wording that expects missing modules is setup evidence, not behavioral TDD evidence. Establish minimal typed skeletons and executable tests, observe actual failing assertions, then implement behavior. No artificial tests for inert configuration. Cost if wrong: a small additional setup step.

- Строка журнала 139: - Ruling: Common signatures are contracts, but definitions whose inputs are assigned to later tasks may be introduced with that producer, not as broken forward imports in Task 1. FileTools is shared type; implementation belongs to worker. Keep contracts independent of apps. Cost if wrong: type-only refactoring.

- Строка журнала 140: - Ruling: ReferenceLibrary.tsx is specified in Task 3 before React exists. Task 3 delivers catalog APIs and data; Task 4 integrates this screen. Admin remote mutation wiring completes with Task 7. No functional scope removed.

- Строка журнала 141: - Ruling: Tests shown with fixture variables in plan require concrete fixtures/builders in each task; literal incomplete snippets are not ready-to-run tests.

- Строка журнала 142: - Ruling: The branch is not complete without the promised native/cloud acceptance evidence. Missing Mac or credentials is recorded explicitly while all runnable code and local tests continue.

- Строка журнала 240: - Task8 NEEDS_CONTEXT handled per handling-reports: approved scoped managed-runtime/remote-worker adapters plus native enrollment/settings beyond brief's short file list. Ruling: transient existing in-memory user session token may pass renderer→dedicated main-local Rust command→configured pinned HTTPS control origin to enroll; server rechecks admin, Rust consumes/stores separate worker credential in OS/private transport and returns safe summary only. No log/persistence of user bearer, redirects/arbitrary per-command origin, or secret return to renderer. Enrollment retry/recovery and launch/stop/revoke lifecycle must be usable. Reason: spec requires actual trusted machines, not fixture-only queue. Cost if wrong: narrowly bounded adapter/native changes.

- Строка журнала 241: - Ruling: Task8 may create normalized private.publication_reservations with UUID, stable request-key binding, origin and settlement link, transferring site_operations atomically. Provider phases stayTask9's ledger. Reserve/settle methods server-only; a worker may request current-lease-bound handoff but cannot assert verified external success. Unresolved reservation survives cancel/revoke/expiry/terminal jobs. Reason: queue lifecycle must not release an unknown external effect. Cost if wrong: migration/seam adjustment before deployment.

- Строка журнала 259: - Task9 automatic continuation ruling: explicit authenticated Resume is fallback, not manual per-site requirement for normal/nightly auto-publication. Approved optional Queue.continuePublications remote tick with empty body; one separately throttled driver per runWorker runs even when both generation slots busy. Server validates unrevoked worker and selects due already-authorized intent; no client target selection/unassigned files/sensitive response. Steps/account locks authoritative across devices, quota/DNS waits free device slots. No automatic offline scheduler/cron claim unless configured; unused cron machinery not needed.

- Строка журнала 278: - Task10 NEEDS_CONTEXT handled per handling-reports. Ruling: approve focused contracts/import, pure bounded parsers, normalized local-database SQLite transaction/ownership/migration/snapshot with existing local factory facades and site-scoped editing, staged import resources, local/postgres batch adapters plus in-transaction site admission extraction, routes/native/client/UI/logo resolver. Set Node minimum >=24.21.0 consistently; bundled runtime already matches. Keep DB transactions synchronous/bounded, no external async work; retain legacy originals through validated reopen. Reason:5000-record scale cannot rely on growing2MB JSON documents; cost is confined local adapter/migration work, central managed authority unchanged.

- Строка журнала 319: - Ruling: Task7 follow-up added002_invitation_attempts.sql, so Task8 queue migration must use003_queue_leases.sql instead of its brief's002_queue_leases.sql. Later tasks use the next unused numeric prefix rather than duplicate migration versions. Reason: immutable ordered Supabase migration identity; filename-only adjustment, no scope/behavior change. Cost if wrong: undeployed filename update.

- Строка журнала 342: - Ruling: Task 5 may publish the accepted immutable Revision itself, keeping draftId/publishedId equal when that accepted version is public. Revision.kind records provenance and is not sufficient proof of publication. Successful publication must have durable site/revision/manifest intent-outcome evidence; Task 9/12 build actual publication history from successful outcomes and initial-generation publication, never from kind alone. Pending/failed intents do not count. Reason: preserve immutable revision identity while keeping accepted/published pointer semantics coherent. Cost if wrong: publication-history adapter refactoring; website bytes unaffected.

- Строка журнала 344: - Ruling: All later Cargo commands must explicitly set CARGO_TARGET_DIR to this checkout/.local-state/cargo-target — host inherited C:/speech-vulkan-ninja caused one initial Task4 build cache write outside checkout. Subsequent build/test commands and committed launcher use local target. Do not delete the external cache or touch speech sources. Cost: duplicate local build cache; avoids unrelated project build-state interference.

- Строка журнала 345: - Ruling: Task 3 introduces immutable RevisionRepository {put,get} and a local adapter, injected as WorkerDeps.revisions. Site.draftId/publishedId always reference Revision.id, not Manifest.id; resolve Revision.manifestId for file access. Persist the intended publication revision identity/metadata with archive and intent before provider calls, register the published revision only after provider reports published, then CAS Site; identical put is idempotent for crash recovery. For edit jobs, archive validated candidate files/private checkpoint without mutating Site pointers/revision or publishing; Task 5 owns registration/accept/reject. Reason: plan omitted revision persistence and direct draft installation would violate approved candidate acceptance. Cost if wrong: additive port adapter refactoring; no change to product flow.

- Строка журнала 346: - Ruling: Task 3 extends CheckpointStore with trusted load(checkpointId), returning checkpoint/private state/files; pipeline verifies job/site ownership and validates restored state. Job.generation may optionally freeze seed/styleId/templateVersion via trusted catalog.prepare; fallback selections persist before assets/model and cannot change on retry, catalog disable, or template update. Missing pinned version fails clearly. Persist archive manifest and deterministic publication intent before any publication call; Task 9 adds real intent storage/wiring. WorkerDeps may inject catalog/workspace/validator in addition to required ports. Reason: saved stages must actually be reloadable and stable without app-to-contract imports. Cost if wrong: type-only orchestration refactoring; no external account side effect.

- Строка журнала 364: Task11 Ruling: approve focused migration007 + optional trusted claim mode visual/all to permit enrolled workers without configured model key to perform deterministic visual Save only. Reason: producer bypass alone cannot overcome managed.start model gate or an unfiltered queue claim; ordinary unenrolled editor selection remains independent. Implement one two-argument claim function with producer predicate BEFORE LIMIT1/FOR UPDATE; retain one-argument behavior through a thin wrapper rather than duplicate state machine. Preserve existing site→worker→job locking, post-lock clock, capacity2, leases120s/30s, reservations/exclusion/fencing and service-only grants/search_path/security-definer. Strict DTO/native allowlists; visual-only never claims AI jobs or creates fake managed generation. Local optional filter uses same semantics. Cover oldest AI job not starved/consumed by visual-only worker and unchanged default claim behavior; explicit native enrollment remains mandatory. Cost: narrow claim/start contract/migration addition, no new executor or weakened ACL.

- Строка журнала 369: Task11 Ruling: approve narrow monotone authorization-denial fence for a pending visual Save when fresh original saver no longer has site:edit and cannot obtain ordinary edit admission. Under existing site lock, refresh original actor rights and terminally fail only that pending Save; no source/pointer mutation or grant of editing admission to user role. Final visual CAS and every journal/candidate update must preserve and recheck terminal denial, including after role restoration and while worker completes. Same-key replay stays terminal; a new explicit Save is separate. Reason: otherwise early GET/status denial leaves durable autoaccept pending and later role restoration can install without fresh Save. Cost: bounded terminal-state authority/fence path, not a second acceptance engine; regression includes downgrade→own status→rights restored→replay/no install and concurrent completion fencing.

- Строка журнала 381: Task11 fix1 Ruling: approve additive trusted final visual-CAS port receipt so managed final authority outcome and existing candidate acceptance/Save journal commit in the SAME site-locked transaction as either denied pre-CAS work or successful draft CAS. Typed completed/failed receipt + trusted journalCommitted indicator lets core avoid a redundant now-revoked guarded write; local adapters retain existing core journal path. Final port must re-read/bind immutable candidate/Save/base/admission and fresh original saver authority, not trust renderer/worker receipt metadata. Early denial classifies actual installed immutable Revision/base receipt before failing outstanding work; terminal fence protects both completed and failed from stale writes. Reuse existing acceptance domain transitions/helpers, no second engine or validation bypass. Own-operation terminal response may expose only existing safe receipt; lost role/site scope must not grant fresh source/projection/archive/site access. If response is forbidden after legitimate install, durable result still completed rather than false failed. Cost: narrow atomic adapter/core return contract, removes two transaction windows; require before-CAS and after-CAS actual-adapter regressions/replay.

- Строка журнала 392: Task12 Ruling: approve adapter-affine portable backupv1: local→fresh local and managed→fresh managed on another configured machine/installation/storage, both complete paths. Source adapter/schema declared and authenticated in format, wrong target adapter rejected before target staging/install. Stable semantic IDs and physical-key remapping/verifiedAuth mapping/quarantine remain required; no dependency on original artifact storage. Cross-adapter local↔managed conversion is a separate validated migration feature, not implicitly promised by independent backup. Reason: local demo principals/SQLite envelopes and managed Auth/provider journals differ; no preexisting user data migration was requested. Cost: v1 cannot directly import demo DB into managed DB; document scope and keep standalone sourceZIP hosting portability separate. Test adapter mismatch leaves target unchanged and real same-adapter independent restore with original store unavailable. No external action/format-dependent install code had run before ruling.

- Строка журнала 394: Task12 locality ruling: approve focused backup-archive.ts (trusted Node streaming crypto/ZIP), local-backup.ts, postgres-backup.ts and common recovery-record validator; required core facades/contracts remain. Reason: filesystem quiesce/root switching and managed Auth/SQL/R2 mapping have distinct responsibilities and should not bloat retention adapters. No new framework/broad rewrite; Node-only implementation stays off renderer imports. Exact paths/report required.

- Строка журнала 395: Task12 Ruling: confirmed managed validation PNG producer gap is load-bearing for approved evidence/backup scope. Approve optional trusted WorkerDeps.readValidationScreenshot(id) and focused lease-bound private screenshot preparation/upload/verification/registration integrated before accepted checkpoint CAS. Use existing bounded staged/signed resource transport, exact site/job/checkpoint/lease/id/hash/MIME binding and current authority recheck; IDs match exact authorized validation/<uuid>.png/legacy rules, not arbitrary paths/URLs. PNG bytes stay out of public site archive, renderer requests and generic private replay DTOs. Registered evidence screenshots must resolve to verified inventory and authorized existing screenshot read endpoint across devices. GC/pins/backup roots cover staging and accepted images. Do not blindly impose logo2048-height bounds on fullpage validation captures; define bounded screenshot envelope matching actual validator and test real375/1440 PNGs. Historical missing images make claimed-complete snapshot unavailable until verified backfill; no placeholder/fabricated historical evidence. Optional hook absent may not silently omit actual production screenshots; fixtures provide valid bytes or explicitly empty fake validation.

- Строка журнала 396: Task12 Ruling: native backup assembly may supply pinned packaged template/reference content absent from control catalog metadata, but only via bounded typed snapshot resource inventory with exact version/content digests and verified installed package source, no arbitrary renderer paths or unchecked version labels. Historical unavailable pinned content is explicit incomplete backup, not silently replaced by newest template. No general asset framework/new provider; focused producer/reader seam closes existing required scope. No native GUI/live provider actions authorized.

- Строка журнала 397: Task12 Ruling: approve concrete checkpoint implementation relocation apps/worker/src/checkpoints.ts→packages/adapters/src/local-checkpoints.ts with compatible app re-export, preserving exact parser/export/import/envelope/path/hash/provenance behavior. Reason: local staged restore must reuse actual existing parser without duplicating it or adapter→app cycle. No state-machine rewrite; existing checkpoint/pipeline/editing and staged restore checks cover move.

- Строка журнала 400: Task12 capacity Ruling: prototype2.147GB/100k/24MB constants confirmed provisional, not required by ZIP64/crypto. Approve format bounds48GiB plaintext per envelope (below2^36−32 GCM bytes),1million ZIP entries,500000 metadata records/256MiB metadata total,32MiB member, authenticated index chunks<=1MiB and lazy multi-pass ZIP. Subject to actual streamed representative5000×6×(5source+2PNG)=210000payload inventory plus metadata/memory checks and separately reported real smaller roundtrips. Do not hold all yauzl Entry objects, one giant index string or all installation logical records in one JS array; disk/SQLite staging/iterators and bounded pages allowed, validation complete before target install. Distinguish projected inventory limit vs measured full-byte throughput, no claim48GiB tested if not. Worst cases beyond one GCM envelope fail explicitly, never truncate; no multipart framework required in v1. Technical bound is not a generation money cap. Existing normal5000 metadata capacity fixture still required.

- Строка журнала 402: Task12 Ruling: approve durable settlement ordinal in NEW008/local sequence to order current+5 exactly when verification milliseconds tie, preserving original observed external timestamps. Preserve/reseed ordinal after restore; legacy ambiguous order cannot be fabricated (provable receipt/revision order or conservative protection/explicit uncertainty). Current pointer always root; tied times and return-to-old-bytes actions tested.

- Строка журнала 408: Task14 lifecycle Ruling: pinned Playwright1.64.1 actually detaches Unix browsers into separate groups (coreBundle10023–36; kill-browser group10104–15), so Node-group-only cleanup is insufficient. Controller read245word preflight correction and approves fixed packaged mac browser-owner helper via supported executablePath, registers own anchored group over private watchdog channel and waitsACK BEFORE starting exact resource Chrome/shell without detaching. Preserve pipes3/4/defaultargs/sandbox; anchor retained through acknowledged cleanup prevents reusedPGID signaling. No public arbitraryPID/executable input or post-launch scraping, no helper GUI/OScredential init/vendor patch. Same seam validation/preview/selection; Windows Job barrier unchanged. Tests for prelaunch/afterspawn timeout/parent failure; actual mac platform evidence remains pending.14stillREADONLY until13 gate/BASE.

- Строка журнала 410: Task12 archive-writer Ruling: pinned yazl3.3.1 source retains all Entry/callbacks and scans from index0 per entry, giving O(N²) at representative755k; tiny ZIP tests cannot justify target. Approve replacing/removing yazl with focused STORE-only ZIP64 writer in trusted backup-archive.ts, using maintained NodeCRC32/SHA/crypto, bounded current member<=32MiB, awaited partial-write-safe I/O and disk-spooled central directory. This is container serialization, not homemade cryptography; AES256GCM/scrypt remain built-in and maintained yauzl strict two-pass reader remains. Verify headers/ZIP64 sizes-offsets/counts/UTF8flags/DOS metadata/CRC against primary PKWARE format, not invented dialect. Cross-check standard-reader interoperability and >65535-entry ZIP64 boundary, corruption/missing/oversize/abort cleanup plus actual index load memory. No compression/append/encryption feature/general ZIP framework added; schema/envelope/path/48GiB resource scope unchanged. No whole-index Map/nameSet/array retained: private SQLite disk inventory/name index approved. New large tests must distinguish projected byte budget from actual authenticated-index and writer exercise, heap/RSS sampled vs peak honestly. Existing prototype usage not final capacity proof.

- Строка журнала 411: Task12 catalog Ruling: approve explicit installed-catalog CURRENT pointer/set plus version→immutable physical bundle edges. GC roots exact current installed set and semantic active/retained-history/evidence version refs and export/snapshot pins; superseded wholly unreferenced bundle becomes eligible after24h, no permanent all-catalog bypass. Current pointer changes only on verified authorized catalog-install/server configuration transition, not ordinary backup read or stale worker/client snapshot upload. Restore preserves recorded source current pointer semantics (not guessed latest timestamp) while storage keys remap; destination package updates must reconcile exact versions. Tests: B1 still rooted by old job/history/pin after currentB2, then B1 collectible after refs/pins gone+grace, B2 survives; stale client cannot roll pointer backward.

- Строка журнала 414: Task12 legacy-local Ruling: where pre008 local envelopes lack durable predecessor proof, do not invent accepted ancestry. Exact reader verifies/registers immutable ID/site/job/physical digest; current pointer, explicit trusted recovery ticket or any existing durable accepted-snapshot marker can prove projection/root. Other envelopes stay acceptance-unknown, kept at least30day detail horizon, then collectible only with complete relevant incoming-root/reference coverage, no execution/retained/evidence/read/export pin and24h observed grace. Unknown version/closure blocks that subject rather than unsafe inference. Preserve inventory identity/hash/provenance after payload pruning. Do not classify unknown as accepted/unaccepted or permit new references to tombstoned payload. Existing reviewed older accepted-snapshot recovery must use its actual durable authority marker if present; unsupported legacy eligibility is explicit, not file-presence authorization. Latest pointer alone updates latest usage, older proven CP evidence/edges only. This allows unnecessary legacy detail expiry without blanket permanent protection and preserves required current/history/recovery roots.

- Строка журнала 415: Task12 recovery reconciliation Ruling: require the narrow product admin route/UI, not offline SQL-only escape, because unresolved restored effects are an expected recovery case. Add read-only existing-publisher inspection/receipt adapter bound to restoreId+reservationId+configured account scope+immutable frozen binding+original evidence digest; preserve source provenance. No Vercel PUT/POST/DELETE/upload/promote/automatic recomputation or new publication framework. Exact server-observed terminal proof may use existing normal settlement/cancellation transitions; ambiguous/no-proof case returns concrete manual-reconciliation-required with quarantine/exclusion retained. Operator source-retirement/account acknowledgment is necessary but not a substitute for provider proof, and a client confirmed:true/raw text must never release unknown effects. Fresh admin/binding recheck on commit, network outside DB locks under proper pins, stale concurrent inspection rejected/idempotent. UI exposes safe status/action, not secrets/raw provider data. Tests assert no provider mutation across all branches and no release on ambiguous/forged/stale proof. Actual provider/account/platform acceptance remains14; implement adapter/route/tests now. Recovery docs still cover genuine out-of-band cases without unsafe blanket clearing.

- Строка журнала 426: Task12 fix1 I5 Ruling: approve internal retention-sql.ts focused dialect-specific scalar roots(kind,id,purpose)/recursiveUNION closure in DB-managed temp tables/indexes; adapters own FIRST fences/transactions/I/O, core semantics preserved. Setwise GC+durable claims then64row outside-transaction reads; localprotected paged iterable preserves purposes/legacy/proven recovery roots. SQL count/serialized-byte budgets before hydration/backfill/capture with coherent recheck, statement/workmem bounds and explicit rollback failure, includes edges/evidence/inventory; no NodeFS/network/crypto under locks. Actual5000×6 metadata/edge snapshot/GC required, no13.7GB bodies. Bounded scalar catalog header list allowed (prefer existing count/byte limits; proposed10000 only explicit upfront technical bound, never slice/latest substitution), cleanup bounded batches must leave remaining work discoverable. Why: resolves explicit no-whole-installation-array ruling with existing normalized stores; cost if wrong: focused SQL seam/performance rework, no product scope change.

- Строка журнала 429: Task12 fix1 I5 measured actual target:5000×6 with5source+2PNG has630008logical DB rows incl240k typededges/120kinventories,270000physical-file descriptors (150ksource/60kPNG/60kdetail),900009metadata records and1170009old-layoutZIPmembers beforeindexes. SQLaggregate actual serialized logical450854933B+descriptor81300000B=532154933B; bodies13.5GBprojected NOT written;seed+aggregate30.24s. Savedtask12-fix1-full-volume.json. Root Ruling: old500k/256MiB/onerecord-member assumptions undercounted promised normal target, do not reduce fixture to light success. Approve focused optional typed embedded file-descriptor fields on paired authenticated index entries (recordName/root/path/MIME, reuse authenticated payloadname/size/hash), disk reconstruction with all prior root/path/MIME/binding/duplicate/unmatched checks, old archives readable/new unsupported features failclosed; no bodygrouping/framework/crypto/sourceZIPchange. Count expanded logicalrows+descriptors. New metadata1Mrecords/768MiBserialized, retain1MZIPentries/48GiBplaintext/32MiBmember/<=1MiBindexchunks/192MiBindexpendingactualmeasurement.512MiB only4.7MB beyondmeasuredtarget insufficient for approvedTask13aggregate rows,768MiBboundedheadroom while nohydration. Approve exactsafeBIGINT namespaces originals<1M,chunks[1B,3B),verified4B,metadata5B,prepared6B with boundedstrides/routing and rejectoverlap/outofrange. Reason: support measured requiredtarget rather than certify undercounted capacity; costifwrong: focusedformatcompat/performance rework, no externalservice/purchases. Required old/newpairedroundtrips, hostilecompactdescriptors, actualfulltargetsnapshot/GCcount/bytes success, trueoverboundupfrontreject/zeroremnants, no13.5GBbodyclaim. If192MiBindex insufficient require exactmeasure beforefurtherchange.

- Строка журнала 431: Task12 fix1 I5 measured capture/locking Ruling: full900009record attempt after scopedcachecleanup(Cfree4.93GB) reachedmetadataINSERTs then15sclosuretimeout. Owner identified UUIDevidence e.id::text anti-index scan underOR, fixingtemptextPKevidenceIDs, closure-before-copy and duplicatepreflight. Fullcopy itself tensofseconds exclusive fence, so approve DEDICATED managedsnapshot SESSION-SHARED advisoryfence on checkedout physicalsession BEFORE BEGIN REPEATABLE READ; coherentMVCCmaterialization/pins commit thenunlock/release, rollback/unlock everyfailure/destroyconn ifunlockuncertain, no upgrades. Ordinarytransactionfirstshared andGC/restorefirstexclusiveunchanged. BEGINRRthenblockingadvisorySELECT isunsafe(MVCCsnapshot mayprecede waitingcollectorcommit). Explicit server direct/session capability required BEFORE anysessionlock; unknown/transactionmodebackupfailsclear, no URL/portguess/sessionlockprobe/secondDBURL/newservice. CurrentDATABASE_URL hadnomodecontract. Verified official Supabase https://supabase.com/docs/guides/database/connecting-to-postgres transactionmodelimitations and PostgreSQL https://www.postgresql.org/docs/18/sql-set-transaction.html / https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html; sessionstate/locks unsupportedacrosstransactionpoolerqueries, RRfirstquerysnapshotfixed. Sameauthority/sessiondocumentedconfiguration; costifwrong: requireoperatorcorrectdirect/sessionendpoint/rollbackfeature, notcorruptsnapshot or globalwriterpause. Testcollector-before/queuedcapture, ordinarywriterduringcapture, observedGCwaituntilcommittedpinsandrespectafter, failuretimeout0snapshots/pins/nolocks, denyunknown/transactionbeforelock, destroyunlockfailure. FreshfinalauthorityviaSAMEsessionRCaftercommit OR afterunlock/releaseordinaryfreshcheck; doNOT open2ndsharedwhileholdingSESSIONsharedbehindqueuedGC(deadlock). RRrereadnotfresh. NoNodeIOunderlocks, statement/timeworkmembounds, measuredshared-durationreportedhonestly. Thisfocusedcaptureexception supersedesoldexclusivesnapshotrulingonly, no generalisolationframework.

- Строка журнала 434: Task12 fix1 I5 transport Ruling: measured58sbeginSnapshot exceeds NativeArchives.call30s blanketdeadline. Approve180s ONLYexactPOST/admin/recovery/snapshots issuance, fixedtrustedselector/backgroundprivate operation; ordinary/chunk30s, snapshot1h/nativeop30minunchanged. Bounded declared-safeAppErrorcode/message propagation for actionableDBmodeerror; knowncodes/response+textbounds, rawprovider/DB/stacks/unknownerrorsgeneric. Checkedcontrolvercel.json onlyrewrite; official https://vercel.com/docs/fluid-compute confirms HobbyFluid300smax and https://vercel.com/docs/project-configuration/vercel-json supportsperfunctionmaxDuration. Approve LOCALfluid:true +functions api/index.ts maxDuration240 preserve rewrite (180clientheadroombelow300max); boundedcaptureSQLtotal/query belowclientdeadline, documentactualFluid/direct-sessionconfig, no providerdeploy/tierpurchase/action/priceclaim. Why: actualsupportedmetadatacaptureotherwiseunreachablefromnativepath; costifwrong: focusedtimeout/deploymentconfigrollback, platformacceptanceremains14. No mirror-onlyconstanttest; focusedactualtimeout/errorboundarywherepractical.

- Строка журнала 436: Ruling: addTask15transportreachability prerequisite afterTask12reviewgate before13→14, preserveexistingtasknumbers. Read-onlyTask14auditactualcodeperrecord900009GET/1800018POST+singleinstall45001SELECTminimum exposes reachable-sizegap despite boundedrepresentation; conditionalRTTarithmeticNOTbenchmark. Focusednewtaskbyte/countboundedremote batches, durablepagedprepare/atomiccommit, boundedrenewal/cancel/freshauthority; preservearchive/native64k boundaries/providers/productscope. Userapprovedcompleteimplementation/subagents/no repeatedconfirmation, thisclosesexistinglargebackuprequirement, no newproductapprovalgate. Cost: additionalserialtask+independentreview, no service/purchase. Trackedplan updatedbycontrollerONLYdocumentation, pendingcommitownednexttask; no productioncodeedited. Task12scopedfixreviewcontinues2d2aHEADpackageunchanged; Task15productionnotGOyet.

- Строка журнала 442: Task15 preflight974words READY readfull bycontroller; handling-reports reference reread. Ruling: approve boundedbatch+operational009progress/receipts/claims and separatelypagedpreparation/atomiccommit against2d2a9e4. Portablelogicalschema8/formatunchanged because009operational-onlyexcluded, SQLschema/migrationnumbernotinventedbackupschemabump. Raw1MiB/JSON2MiB/metadata256/resource64/runnerinflight4; permetadatarecord1000000B is EXISTINGrecovery-records.ts70/112/postgres-backup.ts124limit verifiedbynarrowrg, notnewdowngrade. Route-specificlargerparserONLYexactadmintransferpathsafterAuth/scope, other64k/native24kunchanged. Hash/receiptbindingexcludesmutableTTL/credentials, descriptorwindow/cursor/count/bytes completenessserververified, conditionalwriteexactreplayonly. Preserve64MiBglobalobject-stagingbudget andschedulelarge32MiBobjectswithoutquota-deadlock; no budgetbypass.

- Строка журнала 443: Task15 lifetime/session Ruling: successfulauthorizedtransfer/progress renewslivepins60min capped24h, no revival, no databasekeepaliveafterwork/polling/disposalends; sourcepinsreleaseassoonnolongerneeded. Credentialsvolatileonly; stableJWTsessionidentityacceptedONLYfromexactbearerverifiedbyconfiguredcontrol/session andserverAuthPort, notbody/unverifiedclaim/userIdalone; opaque/missing-stable-sessionexact-tokenfallbackwithclearreauth-requiredstateandboundedstagingexpiry. Sameverifiedsessionrefreshupdatesonlyinmemoryslot, true logout/newsession/origin/mode/roleloss cancel+drain, cleanupsdoNOTgrantread/renew. Working-statuscache≤30s SAMEexacttoken onlysafeprogress metadata, notfinalhandles/files/reads/save/issuance/caprenew; tokenchange/newaction/releasefreshverify, eachbatchfreshserveradmin. ExistingcorePrincipalcontractsnotreplacedbynewAuthframework; privateverifiedcontextkeepsauthoritynotserializedclaims. ReportactualHTTPsession/renewoverheadinsidebudgets.

- Строка журнала 444: Task15 prepare/commit Ruling: ≤256records/1MiBcohort, cooperative10srequestwork withboundedexistingone-recordIO, durablevalidationphases/claims, batcheduuid/keylookups+preparedinserts; immutableverifiedbodydigestsreuseinsteadrevalidatingeverypayloadperstep. FinalreadycommitonlyknownSQLtablesunderexistingFIRSTexclusive/freshauthority/emptytarget/quarantine/provenancereport, perstmt15s/cumulative105s/lockwait5s/client180exactcommitendpointifneededbelowFluid240; no network/FS/crypto incommit. Existingactor/sourceidentity/privateprojection/quarantine/publisheraccountsemanticsunchanged. Internalrestore-ownerexclusionfromclosewaitmustbeunforgeableinternalcapability, notrendererprovidedskip; allotherownedrequests+maintenancejoinedbeforeDBclose. No newproviders/dependencies/crypto/archivecontainer/generalworkflow. Alltest/callbudget/disk/actualvsconditionalevidence requirements retained. Reason: closeexistingapprovedbackupreachability/closegap, notnewproductfeature;costfocusedprotocol/adaptorworkandreview.

- Строка журнала 447: Task15 renewal-scale guard Ruling: coalesce durableTTL/pinupdates; successfulfreshlyauthorizedbatchmayreturncurrentliveexpiry, avoid120k/270kpinrewrites×~3500pages. Renewnear-expiryboundedsetwise/or equivalentownerjoin, no expired/claimedrevival, nativeopcoveredbyreturnedliveexpiry. Freshadmin/scopeEVERYbatchunchanged, no privilegecache/newbackgroundscheduler. Fulltargetactualcost catches regression; no mirror-onlytestdemand.

- Строка журнала 455: Task15 securityselfreview Ruling: operationalverifiedsessionboundATsnapshot/restoreissuance, neverfirst-readeradoption. Every snapshot/restoreTRANSFER-IDHTTProute (legacyrecord/resource/stage/mappings/install/IDstatus/release +newbatch/prepare/commit/renew/cancel) guardbeforeprivateaccess/mutation; no userIdonly/bodySID/scopefreeHTTPfallback. Oldunboundpreupgradecapsfailclosed/recreate. Directtrustedadaptercompatprivateonly. Addsameuser/newSIDoldroute+beforefirstbatchnegative/sameverifiedSIDrefreshpositive. ApplyAFTERcurrentfrozenfullrunfirstresult, thencoveringguards/evidencesequencing. CLARIFICATION: installation-wide GET/admin/recovery/status andPOST/admin/recovery/release NOtransferID remainexistingfreshadmin/quarantine/accountauthority; publicationreconciliationIDsexistingindependentrestore/evidence/frozenbindingauthority. Newauthorizedadmin/deviceCANfinishdurablerecoveryafteroldtransfersessionTTL; no newglobalSIDrestriction. Thisclosesnewtemporarycapabilitybypass, preservesproductworkflow/corePrincipal/archive/portabletables.

- Строка журнала 456: Task15 prepare-bound Ruling: approvepurecheckpoint-evidence-from-file-digestshelper extractedfromexistingprojectCheckpoint(bytes), bytewrapperdelegates/outputsunchanged, no duplicateprojection/state machine. RestoreinputsONLYservertrustedimmutableperobjectproofsexactpath/size/MIME/SHA256/SHA1matchedmanifest; missingoldSHA1computedinexistingboundedbodyverification/proofupgrade, NEVERtrustclient/manifestSHA1orinfersolelySHA256. Preserveimage/producer/site/authority/source-targethash/Authprovenance. StateoneboundedR2read;no newformat/HTTPprojectioninput/dependency. Behaviorno-fileredownload+bytepathequivalence/existingevidence/native/mappedvisualcoveringrequired. ApplyAFTERcurrentfrozenfullrunfirstresult, recordchangedpathsequencing.

- Строка журнала 458: Task15 /session Ruling: freshmembership-ONLYplaincurrentSELECT AFTERexactbearerauthenticationmayavoidinstallationpayloadfence; inspectentireauthenticationpathsoearlierresolverdoesn'tstilllock. NormalFIRSTsharedtx andallrealtransfer/resource/prepare/commitfreshAdmin/payloadfencesunchanged,no rolecache/globalAuthframework/Principalchange. Safeexistingprincipalprojectiononly,nopayloadrefs. HeldEXCLUSIVEcommitregression/sessioncurrentroleresponsive/realbytesstillfenced/rolelossnohandles;name/handlepoolstarvationifobserved. Why: actual40.35scommitfits105SQL/180client/240Fluid butworkingstatus30srevalidationmustnotcancelvalidcommit; no privilegeextension. Read-onlymembershipdoesnotcreatepayloadrefs andneedsnolivenessfence. No newDBauthority/service/timeouts.

- Строка журнала 465: Task15 exactpreparepageEXPLAIN cursor235007 healthy1.776ms/256rows/indexedPK2072hits51reads0filtered; evidence.local-state/task15-final-prepare-plan.json. Rootruling: afterfrozenfirstverdict implementexistingbriefboundedcohort bulk immutable availability/source/producer reads≤256/1MiB, shortexistingFIRSTsharedfenceSQL, preserveEVERYtyped/perobjectvalidator/freshrequestactorSID/finalreadycommitchecks; no globalcache/clienttruth/networkFScryptounderTX. Reasonperrecordshorttransactionoverheadmeasured, nopagination/plannertweak/no raisedguard. Owner mustsurfaceauthoritysemanticdifferencesbeforecode; sourcefrozenuntilcurrentverdict.

- Строка журнала 496: Task14 NEEDS_CONTEXT preflight574word delta read FULL; handling-reports reread. Ruling: approve exact finalized manifest SHA256/target/format compiled into main native executable, helpers finalized first/main outside resource inventory/privateIPC anchor/no mutable release env or renderer override/adjacent self-anchor. Nested signed bytes finalized before manifest; final outer signing cannot rewrite them. Unsigned executable replacement outside integrity claim/no new PKI. Why: current existence-only resolver and adjacent checksum cannot establish trusted expected contents; cost extra deterministic build ordering and per-file prelaunch validation. Serial measured disk plan approved2GiBfloor/statedphasecaps/no cache or current-binary deletion; exact capacity mismatch goesROOT for technical ruling, not human stall. Stillread-only/idle until13cleanBASE+explicit14GO.

- Строка журнала 500: Task13 NEEDS_CONTEXT storageUUID question resolved after rereading handling-reports. Ruling: separate read-only stored observation/provenance/frozen-expectation validator accepts canonical8-4-4-4-12hex ALL128bit PostgreSQL UUID values, including md5 fixture arbitraryversion/variant; exactsame-site/currentpublicationbinding retained. No widening renderer/worker actiontarget/claim/token/auth parsers or rewriting stablefixtureIDs. Why: stored UUID compatibility differs from generation/version-specific API syntax; cost if reused wrongly is unintended parser widening, so focused malformed/nonmatching+arbitrarybits tests required. CurrentfocusedSQL61PASS/2sameUUIDfail outof63; no fullcapacitystarted. Normalunit392PASS/2SKIP/13FAIL:oneoldgenericclaimfixtureamended,12timeouts/aftereachEBUSYunder overlappingSQL. Bothended; named4files thenfullunitsALONE/originaltimeouts, preservefailures/no blanketloadexcuse. AllSQL/native/E2E/fullgates serialized;free10,177,126,400BbeforeRust/full.

- Строка журнала 502: Task13 isolatednormalunitstill5s pipeline/edit timeouts+desktopRetryassertion(finaloutputpending), so initialload-onlyhypothesisnotaccepted. Namedlikelyintroducedcost: ActivityTimersealsrecordActivitybeforeEVERYcheck/heartbeat/toolcontinuation→manysynchronousFULLSQLitecommits. Ruling: measurehookwrites/overheadinmeaningfulfixture then coalescebounded30swindows+actualleaseending/jobpause; in-memoryactiveintervalsubtotals/exclusions neednotdurablewriteeverypause, preservefreshauthority/contiguousidempotence/one rowjob/eligiblefinalseal/nullpartial/unsealedgapdiscard. No guardraise/replayrewrite. Server-relativehealthsleep andallowlistedpublicationdiagnosticprojection alreadyapprovedscopealsofinishingBEFOREfullfreeze. Recordandfixrepeatfailuresratherthanexcuseasload.

- Строка журнала 503: Task13 measured activity overheadRED shortjob13durablerecordActivitycommits target≤7; initialboundary-onlyGREEN thenstrongercoalescing correction chosen. Ruling: optionaltrustedActivitySegment on existingQueue.finish/pauseAtBoundary+workerDTO, apply in SAMEactualleaseendingtransaction/freshauthority using shared existing replay-validation helper. Falsepauseboundary doesNOTconsume/reset candidate/sequence. Drain/resolvependingperiodicseal orreplayEXACTimmutablependingsegmentanddiscardunsealedtail; nevermutateambiguoussubmittedsegment. Onerowjob/contiguousmarkers/partialcoverage/unchangedqueuecheckpointsemantics preserved; no renderer authority/newaccountingengine. Actualadapterfalseboundary→finish/pause/race/pendingidenticalreplay tests andnoextraordinarydurablecommitRPC forshortmany-check job required. Why: remove introduced percheck FULLSQLitewrite regression while preservingatomic finaltime at realpause/end; cost small additive trusted port/DTO seam.30speriodicwindowsremain/originaltimeoutsunchanged.

- Строка журнала 504: Task13 atomicactivity actualSQLiteGREEN3falsechecks+finish=4existingtransactions/0extraactivitycalls/30ms; actualpause race+lostACKperiodicreplay95msonce/onerow. FocusedSQL55PASS/1heavyfiltered includesstoreUUID/schema9/diagnostic/PGfalsechecks→atomicfinish. ThirdnormalunitALONEstilldifferent5stimeouts evenfakeQueuewithoutactivityport; no blanketactivitycause/defaultpassclaim. Ruling: ONEentirenormalunitset --maxWorkers=1 samecases/5s120sguards, explicitmulticonnectionracesinsidefilesretained. Preservedefaultfailures/reportserialnotdefaultpass; no moreunchangeddefaultfullretries. Task14ownsresource-budgettestlauncherfinalverify. Do NOTwideninitializeRecoverylegacyDDLoptimizationonunmeasuredsuspicion. Cost: slowerboundedfileparallelismwhilekeepingsemantictests/guards; ifserialalsofails, actualcode/fixtureinvestigationrequired.

- Строка журнала 529: Task14 Ruling: approved Mac private proxy/direct anchor ownership mechanism is saved in task-14-mac-ownership-ruling.md. Watchdog retains direct Child until group cleanup, proxy death cleans actual browser, watchdog EOF triggers anchor self-group cleanup; exact private fds/args, no selectors/sandbox disabling/credentials. Actual Mac acceptance pending. A quoted scratch-note append failed before this corrected reference; no product code changed.

- Строка журнала 539: Ruling: Task14 Mac-only supported macOS.files maps the fixed staged runtime to Contents/Resources/runtime, while generic resources is empty on Mac only and unchanged on Windows — pinned Tauri2.12.2 generic copy_file dereferences symlinks while copy_dir for macOS.files preserves framework directory links — cost if wrong is Mac package layout/signature failure; exact target config and post-app inventory must verify modes/links/hashes, actual Mac execution remains pending. No vendor patch/new Mac staging tree on this Windows host.

- Строка журнала 541: Ruling: after installer inspection/native/corruption/recovery evidence and hashes/JSON are saved, retire only the single owned temporary extracted inspection tree after absolute containment/identity and child-exit checks — an additional retained ~1.1GB tree unnecessarily competes with the final940k gate — cost if wrong is having to re-extract the kept installer. Keep final installer/current release/runtime/stage/caches and unrelated files. Before unfiltered verify reserve at least3GiB estimated temporary spool+PG/index/WAL working space above2GiB free floor; owner must report exact new Task14 intermediate categories and safe reclaim/rebuild consequences before any further cleanup or launch, not silently exceed the floor.

- Строка журнала 542: Ruling: validate extracted NSIS main against the full expected bytes derived from the checked portable main using pinned Tauri2.12.2's exact first __TAURI_BUNDLE_TYPE_VAR_UNK to NSS replacement — bundler bundle.rs35–89/124–135/195–201 deliberately patches and restores this marker, so literal portable/installed hash equality is incorrect — cost if wrong is rejecting or accepting a wrong main, prevented by exact marker/bounds/replacement-count and complete derived expected SHA comparison. No arbitrary difference allowlist, resource inventory relaxation or recompression. Record distinct portable2553ac6b...1972240 and installed97d78d17...a74b34 SHA256s. Only3 marker bytes differ at7264194, both9618944B. Installer474989857B plus inspection1102785526B is1577775383B, below1.5GiB; free2752303104B above2GiB. Actual extracted diagnostics still pending.

- Строка журнала 543: Ruling: after bounded pilot exits and installer/native/corruption/recovery proof is saved, retire only six inventoried Task14-generated native intermediate directories (1519295531B; all born after first release2026-10-29T05:57:43Z) plus the owned Windows staged runtime (~878MB) after saving exact inventory/hash/mode proof and verifying equivalence to KEPT release/runtime — extraction+intermediates alone leave only17463329B beyond3GiB estimated working+2GiB floor, too narrow for full940k — cost if wrong is deterministic restage and ~7m36s Cargo dependency rebuild, not loss of a current app. Preserve all pre-task debug/native/registry/download caches, verified compressed archives, top release executable/runtime, final installer and source/evidence. Native candidates: host release/deps525328483B, release/build199440964B, fingerprint170961B; x64release/deps761930950B, build32269972B, fingerprint154201B. Check exact resolved workspace paths/creation identity/no running children and native LiteralPath only, record before/after bytes/free, no broad cleanup. Remeasure expected≥6.26GB before unfiltered gate; if stage is not solely owned/equivalent, report alternatives rather than delete or weaken fixtures/guards.

- Строка журнала 552: Ruling: measuredprepare37888/940022at500.63s/free2384809984B leaves only237326336B above hard2GiBfloor, so retire ONLY8 newlyTask14-created compressed Mac archives under .local-state/runtime-cache/darwin-arm64 anddarwin-x64 —723167042B total, each birth2026-10-29T06:28:39–06:29:07Z/full lockSHA reverified, Macheader/mode/noticesproof preserved — tokeepunchangedfrozen940kverificationawayfromdisk-full. Exactarm64filesnode-v24.21.0-darwin-arm64.tar.gz52909993B,chromium-1248.zip194831853B,chromium-headless-shell-1248.zip103778487B,ffmpeg-1013.zip1430308B; x64node-v24.21.0-darwin-x64.tar.gz54203979B,chromium-1248.zip205332100B,chromium-headless-shell-1248.zip109130614B,ffmpeg-1013.zip1549708B. Recheckabsolutecontainedidentity/birth/hash, nativeLiteralPathfiledeleteonly/savebeforeafterJSON. Preservecommittedlock/evidence/ALLWindowsarchives/pre-taskcaches/currentrelease/runtime/finalinstaller. Costifwrong: exactverifiedfutureMacredownload~723MB, no lostuser/source/provenance. Thisnarrowmeasurednew-artifactexception supersedes earlierkeep-all-caches rule only for these8files; no broadcleanup/sourcefixtureguardchange/competinggate. SAME42308continues, actualafterfreepending.

- Строка журнала 554: Ruling: prepare808448/940022at935.99s/free2577784832B leaves430301184Bfloor-margin, withunmeasuredfinaltargettables/indexes/WALpeak, so approve retirement ONLYnewTask14Windowscompressedarchive set370310712B selected by committedwin32-x64source lock under.local-state/runtime-cache/win32-x64 — saveexactpaths/sizes/births/lockSHA andresolvednon-reparsecontainednew-fileidentity beforeLiteralPathremoval, before/afterJSON/free afterward — costfutureverified~370MBredownload/restage; currentrelease/runtime/main/finalinstaller/inspectorbinary+sourcearchives+recipe+allpre-taskcachesstay. NarrowexceptiontoearlierkeepWindowsarchivesONLYtheselockednewfiles, no broader70MBtoolcleanup/sourcefixtureguardchange/competinggate. Subsequentcrossedownerboundary1021.08sALL940022prepared/7381preparecalls/ONEatomiccommitinflight/free2380091392B(232607744Bfloor-margin). Exactretirementauthoritysentalready, actualfree/verdictpending; do notclaimPASSfromcommitdispatch.

- Строка журнала 564: Ruling: fixMacownershipsocketonlyunderashortsecurelycreatedowner-onlyprivateIPCdirectory independentofapp-data/TMPDIRlength (fixedshortMacOSroot suchas/private/tmp plusfreshprivate0700directory, exclusivecreation/authenticatedexistinghelperchannel/ownedcleanup); persistedDB/browserprofilesstayapp-data — ordinarylongMacrootcurrentlydeterministicallybreaksstartup/package-smoke — costifwrong: focusedtemporaryIPCallocation/cleanuprework, no newbroker/arbitraryselectors/weakerauth/callerpaths/lengthboundrelaxation. Preserveexistingtoken/direct-parent/FD1–4+5/groupanchorprotocol andsalt/noncechecks; coverlongdata+normalMacsmoke shape/normalfailurecleanup andbothMacchecks. ActualMacexecutionstayspending. Windowsartifact/runtimeimpactmustbeclassifiedfromactualtouchedsources beforeanyrebuild; no blanketheavySQLrerun.


<!-- HANDOFF-APPENDICES-COMPLETE -->
