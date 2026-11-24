import {canRecover} from '../../../packages/adapters/src/openai/responses.js';
import type {Job} from '../../../packages/contracts/src/model.js';

const issueLabels:Record<string,string>={originality:'Материал или композиция повторяет другой сайт, либо страница не содержит обязательного блока.',readability:'Текст слишком мелкий или недостаточно контрастный.',overflow:'Содержимое выходит за границы экрана.', 'mentioned-link':'Обязательная ссылка или блок с её описанием отсутствует либо не виден.', 'reference-placeholder':'В странице остались незаменённые текстовые заглушки.', 'broken-link':'На странице есть неработающие внутренние ссылки.', 'external-request':'Страница пытается загрузить запрещённый внешний ресурс.', 'browser-error':'Ошибка JavaScript на странице.', 'browser-timeout':'Проверка страницы превысила время ожидания.',
 form:'Страница содержит форму или поля для сбора данных.',
 subject:'Основному материалу нужна техническая связь с криптовалютой и задача, которую читатель может решить на сайте.',
 'active-content':'Обнаружена встроенная страница, подмена базового адреса или автоматическое перенаправление.',
 secret:'В одном из файлов обнаружен возможный секрет или закрытый ключ.',
 'script-type':'В файлах обнаружен неподдерживаемый тип сценария.',
 'document-complexity':'Документ слишком большой или содержит слишком много вложенных элементов.',
 encoding:'Один из текстовых файлов использует неподдерживаемую кодировку.',
};
export function jobDiagnostic(job:Job|null,state:Record<string,any>={}) {
 if(!job||!['needs_attention','waiting_provider','paused'].includes(job.state))return null;
 const diagnostic=typeof state.error==='string'?state.error:'';
 const continuation=job.stage==='brief'?state.planningContinuation:state.continuation;
 const retryable=job.state!=='needs_attention'||!!(job.kind==='generate'&&job.checkpointId&&['brief','generate','validate'].includes(job.stage)&&state.imageRun?.status!=='pending'&&canRecover(continuation,diagnostic));
 let code='generation_failed',title='Генерация остановлена',message='Не удалось завершить текущее задание.',action='Передайте код задания в поддержку для проверки. Повтор с сохранённого места пока недоступен.';
 if(diagnostic==='Only static site files are allowed.'){code='unsupported_file';title='Модель попыталась создать служебный файл';message='Генератор запросил файл, который не относится к статическому сайту. Файл заблокирован и не выполнялся.';action=retryable?'Нажмите «Продолжить генерацию»: модель получит объяснение ограничения и продолжит с сохранённого места.':action;}
 else if(diagnostic==='Model response incomplete.'){code='output_truncated';title='Ответ модели оборвался';message='Модель не уместила изменение в один ответ. Сохранённые файлы не потеряны.';action=retryable?'Можно продолжить с сохранённых файлов небольшими правками.':'Автоматические попытки исчерпаны. Требуется проверить результат генерации.';}
 else if(diagnostic==='Invalid model tool arguments.'||diagnostic==='Model repeatedly returned invalid tool arguments.'){code='invalid_tool_arguments';title='Модель прислала некорректную команду';message='В команде отсутствовали обязательные параметры. Эта команда не выполнялась.';action=retryable?'Можно продолжить: модель получит объяснение ошибки и исправит команду.':'Модель повторила ошибку после нескольких попыток.';}
 else if(diagnostic==='Model token budget exhausted.'){code='token_budget';title='Достигнут бюджет генерации';message='Сервер остановил новые платные запросы. Сохранённые файлы не потеряны.';action='Администратору нужно проверить лимит задания или пачки и сохранённый результат.';}
 else if(diagnostic==='Model response stalled.'){code='generation_budget';title='Достигнут лимит шагов генерации';message='Модель израсходовала шаги редактирования. Созданные файлы сохранены.';action=retryable?'Продолжите задание: сервер продолжит обработку сохранённых файлов.':'Нужна проверка сохранённого результата.';}
 else if(diagnostic.startsWith('Originality repairs exhausted:')){code='site_too_similar';title='Исчерпаны попытки переработки страницы';message='Сервер дважды переработал сайт. Последняя версия не прошла проверку, публикация остановлена.';action='Остальные сайты обрабатываются автоматически. Для нового запуска уточните тему или задачу читателя.';}
 else if(diagnostic==='Invalid originality verdict.'){code='originality_review_failed';title='Не удалось сравнить материалы';message='Модель не вернула результат сравнения страниц.';action='Последняя опубликованная версия сохранена.';}
 else if(state.validation?.ok===false){code='validation_failed';title='Страница не прошла автоматическую проверку';message='Автоматические исправления не устранили все проблемы страницы.';action='Нужна техническая проверка результата. Публикация непроверенной версии заблокирована; существующая опубликованная версия сохраняется.';}
 else if(continuation?.recoverable==='account'||/quota|HTTP (401|402|403)/.test(diagnostic)){code='provider_account';title='DeepSeek отклонил запрос';message='Проверьте API-ключ, баланс и доступ к модели в аккаунте DeepSeek.';action='При необходимости обновите ключ в «Настройках», затем продолжите генерацию.';}
 else if(continuation?.recoverable==='configuration'){code='provider_configuration';title='DeepSeek не принял настройки запроса';message='Сервис отклонил запрос к модели.';action='Потребуется проверить настройки интеграции. После исправления можно продолжить генерацию.';}
 else if(diagnostic.startsWith('Provider transport retry budget exhausted.')){code='provider_transport';title='Сервис модели не отвечает';message='Несколько отложенных попыток соединения не удались. Созданные файлы сохранены.';action='Проверьте доступ сервера к API DeepSeek и его статус. Автоматический лимит повторов исчерпан.';}
 else if(/^(Namecheap|GoDaddy|DNS|IPv4|Домен должен)/.test(diagnostic)){code='dns_preflight';title='Проверка DNS до генерации';message=diagnostic==='DNS preflight temporarily unavailable.'?'DNS-провайдер временно недоступен.':diagnostic.slice(0,500);action=job.state==='waiting_provider'?'Сервер автоматически повторит проверку. Токены на генерацию ещё не потрачены.':'Проверьте DNS-провайдера, доступ к домену и IPv4. Генерация ещё не началась.';}
 else if(job.state==='waiting_provider'){code='provider_wait';title='Ожидание внешнего сервиса';message='Сервис временно недоступен или ограничил частоту запросов.';action='Дождитесь автоматического повтора. Если ожидание затянулось, нажмите «Продолжить генерацию».';}
 else if(job.state==='paused'){code='paused';title='Генерация приостановлена';message='Прогресс сохранён.';action='Нажмите «Продолжить генерацию». Для задания из пачки сначала продолжите пачку.';}
 if(diagnostic==='Site subject requirements not met.'){
   code='site_subject';title='Материал не прошёл проверку темы';message='После автоматических правок на странице всё ещё недостаточно объяснена связь с криптовалютой или практическая задача читателя.';
   action='Для нового задания укажите технологию и вопрос, на который должна ответить страница.';
 }
 if(diagnostic==='Static publication checks failed.'){
   code='publication_policy';title='Проверка файлов остановила публикацию';
   message='В файлах сайта обнаружена проблема. Подробности указаны ниже.';
   action='Проверьте исходные материалы и уберите указанные элементы перед новой генерацией.';
 }
 const issues=Array.isArray(state.validation?.issues)?[...new Set<string>(state.validation.issues.slice(0,20).map((i:any)=>issueLabels[i.code]??'Страница не соответствует требованиям проверки.'))]:[];
 return {jobId:job.id,stage:job.stage,code,title,message,action,retryable,issues};
}
