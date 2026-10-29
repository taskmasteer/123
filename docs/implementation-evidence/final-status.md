# Site Factory — итог передачи, 29 октября 2026

Кодовая часть продолжения и согласованная процедура ревью завершены. Исправлен Mac I1; затем закрыты все 16 исходных пунктов итогового ревью. Единственное контрольное ревью не нашло новых Critical или Important, но оставило два реальных Minor с обходами ниже. Результат не называется безусловно чистым или полностью готовым релизом.

Ветка codex/site-factory-pilot и исходный linked worktree сохранены. Merge, push, публикация приложения, запуск установщика и native GUI не выполнялись. Первоначальный docs/SITE_FACTORY_HANDOFF_2026-10-29.md оставлен без изменений как исторический контекст; актуальное состояние описано здесь.

## Код и независимые отчёты

- 8768d2d: короткий приватный Mac owner socket; scoped Task14 review clean.
- 745cbfb94b19b199912fb13eff6ba692b3c3a415: основная финальная волна.
- f89d4604bd31e4052c4ea18a92dd1c53b4badbac: завершение I10 во всех пяти панелях.
- [Исходное итоговое ревью](final-review.md): 10 Important и 6 Minor.
- [Отчёт исправления](final-fix-report.md): все 16 пунктов, команды, RED/GREEN и точные границы исходников/артефактов.
- [Единственное scoped-ревью](final-rereview.md): все 16 закрыты; 0 новых Critical, 0 Important, 2 Minor.
- [Все решения контроллера](decisions.md): дословные строки Ruling в исходном порядке; развёрнутый контекст и поздние уточнения сохранены в архиве.

## Проверки и границы свидетельств

На 745cbfb: 446 unit pass / 2 прежних skip в 50 файлах; полный headless E2E 32/32; выбранные SQL — 67 pass / 2 прежних skip после адресной замены одного ошибочного ожидания; package 11/11; native command schemas 5/5, остальные 20 отфильтрованы; typecheck/build прошли.

После локализованного I10 на f89d460: 14 адресных unit и 6 SQL прошли; 11 различных затронутых UI-сценариев подтверждены исходным прогоном и исправлением двух отказавших fixture-сценариев. Это не выдуманный единый повторный прогон 11/11. Три focus-теста — повтор тех же случаев, а не дополнительные уникальные проходы. Fake clock проверил 24 часа без новых запросов при простое, headless UI — час для пяти панелей. Финальный typecheck, build и новая упаковка прошли.

Исходные неудачные прогоны и исправления оставлены в отчёте и raw logs. Полный 940k/capacity/whole verify повторно не запускался без новой причины. Старые масштабные замеры остаются свидетельствами именно своих fixture и исходников.

## Два остаточных Minor

1. NB1: локальный uppercase-фильтр, например A, вместе с большими записями и дополнительным сокращением страницы по байтам может дать INVALID_INPUT на следующем cursor. Обход: привести поиск к нижнему регистру или снять фильтр и начать пагинацию заново. Данных это не удаляет; managed cursor этим замечанием не признан сломанным. Точный ограниченный probe и строки кода — в scoped-отчёте.
2. NB2: реестр/пачка могут перестать обновлять экран на waiting_provider, хотя независимая публикация продолжает выполняться. Обход: ручное обновление, фокус окна или PublicationPanel. Backend-публикация и её reservation остаются действующими. Следующее исправление должно учитывать безопасную pending-publication activity, сохраняя ноль запросов при настоящем простое.

Оба замечания приняты как реальные и явно отложены после согласованной одной волны и одного rereview. Вторую волну без нового решения пользователя не запускали.

## Текущая Windows-сборка

Локальная unsigned NSIS-сборка из f89d460, 474892758 B (452.89 MiB):

.local-state/cargo-target/x86_64-pc-windows-msvc/release/bundle/nsis/Site Factory_0.1.0_x64-setup.exe

SHA256: 291680e3577715844c8a3be28dbe5a58615254e6c11e0ef005c3adc2c4860a8d.

Portable main: .local-state/cargo-target/x86_64-pc-windows-msvc/release/site-factory-desktop.exe; SHA256 c2193bbfa52cfe5401b648c3535925c015888d56df18cf710ae5b358083492ea.

Runtime manifest: .local-state/cargo-target/x86_64-pc-windows-msvc/release/runtime/manifest.json; SHA256 10985f1224bfa9d9395000d23b7a5b35f17cb59a8ac7f9743fe3da1fc6a204e8. Inventory: 2281 файлов, 877663272 B.

Source metadata: f89d4604bd31e4052c4ea18a92dd1c53b4badbac; dirty=true только из-за сохранённого исходного handoff; fingerprint d8cba2c7a5230fb98423f5cc73f873c7ee327d47ddd3016f3dcae03e14a5b750. Карта 381 исходного файла совпала до/после сборки. Последующая фиксация этих evidence-документов — отдельная документационная дельта, а не новый production build.

Прошли CLI generation/restart, оба bundled browser selector в headless, неизменность inventory после disposal, извлечённый установщик с exact Tauri UNK→NSS transform, compiled anchor, отказ подмены ресурса+manifest, отказ отсутствующего браузера и точное восстановление. Установщик не исполнялся, GUI не открывался; cleanWin11Acceptance=false.

Текущий receipt: .local-state/final-fix-idle-artifacts.json. Первые 745cbfb proofs и common JSON сохранены отдельно; первоначальная проверенная рабочая пара main/runtime/installer — в .local-state/final-fix-before/windows-745cbfb (1362794693 B). Raw logs, receipts, screenshots и бинарные артефакты остаются в .local-state и не являются содержимым компактного ZIP отчётов.

## Незавершённый внешний acceptance

Остаются реальные чистая Windows 11/WebView2/native GUI/chooser/OS-store/lifecycle, macOS 14 arm64/x64 link/package/install/FD/process execution, publisher signing/notarization, настроенные Auth/Supabase/R2/Vercel/OpenAI/DNS/HTTPS и 5–10 личных некоммерческих сайтов, два физических устройства, визуальное одобрение пользователя и полный body/cipher ресурсный envelope. Подробные владельцы — в ревью.

Наличие live-preflight не означает реальный пилот. Малые bodies в fixture на 940009 metadata records не доказывают 13.5 GB реальных bodies, максимальный 48 GiB encrypted archive или стоимость 5000 публикаций. Исходный Task13 raw full-volume JSON был исторически перезаписан; текущий файл не объявляется прежним замером.

## Хранение доказательств

Архив 2026-10-26-records.zip и inventory.json содержат все плоские рабочие записи SDD, включая Markdown, точные diff-пакеты, plan-path и сохранённый partial quota checkpoint. Проверяются полный состав и SHA256 каждого распакованного файла, а также 36 ранее сохранённых отчётов. Полный журнал решений — decisions.md.

Ignored SDD оставлен вместе с архивом, поскольку два Minor не позволяют назвать результат безусловно чистым. Worktree, ветка, .local-state и оригинальный handoff сохранены. Дальнейших source-правок или повторного широкого ревью в этой процедуре не было.
