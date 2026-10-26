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
2. Сбой между загрузкой файла, сохранением этапа и внешним HTTP-эффектом не теряет последнюю сохранённую версию и не запускает публикацию вслепую — задачи 2, 8 и 9.
3. Одновременная правка с двух устройств и запоздавший ответ модели не затирают новый черновик; история чата отделена от принятой версии — задачи 5 и 8.
4. Содержимое сайта с JavaScript, вредным путём или поддельным сообщением предпросмотра не достигает ключей, файлов ОС и Tauri IPC — задачи 2, 4, 6 и 11.
5. Исчерпание квоты, отозванное устройство, неготовый DNS и выключенные исполнители показываются разными состояниями, а исправные задания продолжаются — задачи 7–10 и 13.

## Порядок и результаты этапов

- **A — локальный рабочий цикл, задачи 1–6.** Настоящее desktop-окно: создать сайт, написать правку в чат, сравнить, принять или отклонить, опубликовать в локальном тестовом адаптере. OpenAI-адаптер можно включить после настройки ключа; демонстрационные ответы подписаны как демонстрационные.
- **B — работа через сервисы, задачи 7–9.** Три роли, приватные файлы, два доверенных устройства, восстановление и реальные публикации на Vercel Hobby.
- **C — полный пилот, задачи 10–14.** Импорт, визуальный редактор, версии, резервирование, мониторинг, сборки и 5–10 реальных демосайтов.

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
| История current+5, export, independent backup | 12 |
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

