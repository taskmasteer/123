import brandLogo from '../icon.svg?url';
import {pollLoop} from './lib/polling.js';
import { siteCount } from './lib/labels.js';
import type { SiteFilters } from '../../../packages/contracts/src/model.js';
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { desktopClient } from './lib/desktop-client.js';
import { SiteList } from './features/sites/SiteList.js';
import type { DesktopSite } from './features/sites/SiteList.js';
import type { Catalog } from './features/references/ReferenceLibrary.js';
import type { DeviceStatus } from './features/settings/ModelSettings.js';
import type { SessionView } from '../../../packages/contracts/src/http.js';
import './app.css';
const UsagePanel = lazy(() => import('./features/settings/UsagePanel.js').then(m => ({default:m.UsagePanel})));
const Batches = lazy(() => import('./features/batches/BatchDetail.js').then(m => ({default:m.Batches})));
const CreateSiteDialog = lazy(() => import('./features/sites/CreateSiteDialog.js').then(m => ({default:m.CreateSiteDialog})));
const ReferenceLibrary = lazy(() => import('./features/references/ReferenceLibrary.js').then(m => ({default:m.ReferenceLibrary})));
const SiteEditor = lazy(() => import('./features/editor/SiteEditor.js').then(m => ({default:m.SiteEditor})));
const ModelSettings = lazy(() => import('./features/settings/ModelSettings.js').then(m => ({default:m.ModelSettings})));
const BackupSettings = lazy(() => import('./features/settings/BackupSettings.js').then(m => ({default:m.BackupSettings})));
const Login = lazy(() => import('./features/auth/Login.js').then(m => ({default:m.Login})));
const UsersSettings = lazy(() => import('./features/settings/UsersSettings.js').then(m => ({default:m.UsersSettings})));
const IntegrationsSettings = lazy(() => import('./features/settings/IntegrationsSettings.js').then(m => ({default:m.IntegrationsSettings})));
const PublicationPanel = lazy(() => import('./features/sites/PublicationPanel.js').then(m => ({default:m.PublicationPanel})));
const WorkerList = lazy(() => import('./features/workers/WorkerList.js').then(m => ({default:m.WorkerList})));
type Device = DeviceStatus;
export default function App() {
    const [managed, setManaged] = useState(false);
    const [session, setSession] = useState<SessionView | null>(null);
    const [usageSiteId,setUsageSiteId]=useState<string|null>(null);
    useEffect(()=>setUsageSiteId(null),[managed,session?.principal.userId,session?.principal.role]);
    const [section, setSection] = useState('Сайты');
    const [filters, setFilters] = useState<SiteFilters>({}), [filterDraft, setFilterDraft] = useState<SiteFilters>({});
    const [sites, setSites] = useState<DesktopSite[]>([]);
    const [pageCursors, setPageCursors] = useState<(string | null)[]>([null]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const cursor = pageCursors[pageCursors.length - 1] ?? null;
    const [catalog, setCatalog] = useState<Catalog>({ styles: [], references: [] });
    const [loading, setLoading] = useState(true);
    const [loaded, setLoaded] = useState(false);
    const [pollError, setPollError] = useState('');
    const [device, setDevice] = useState<Device | null>(null);
    const [creating, setCreating] = useState(false);
    const [catalogError, setCatalogError] = useState('');
    const [actionFailure, setActionFailure] = useState<{
        message: string;
        method: string;
        site: DesktopSite;
    } | null>(null);
    const [preview, setPreview] = useState<DesktopSite | null>(null);
    const [publicationId, setPublicationId] = useState<string | null>(null);
    const publicationSite = sites.find(site => site.id === publicationId);
    const [editorId, setEditorId] = useState<string | null>(null);
    const [refresh, setRefresh] = useState(0);
    const editedSite = sites.find(site => site.id === editorId);
    function changePage(cursors: (string | null)[]) {
        setPageCursors(cursors);
        setNextCursor(null);
        setSites([]);
        setLoaded(false);
        setLoading(true);
        setEditorId(null);
    }
    async function loadCatalog() {
        try {
            setCatalog(await desktopClient.request<Catalog>('catalog.list'));
            setCatalogError('');
        }
        catch (error) {
            setCatalogError((error as Error).message);
            throw error;
        }
    }
    useEffect(() => {
        if (!managed || session)
            void loadCatalog().catch(() => { });
    }, [managed, session]);
    useEffect(() => {
        if (managed && !session) {
            setLoading(false);
            return;
        }
        setLoading(true);
        let stopped = false;
        async function poll() {
            try {
                const [list, status, currentSession] = await Promise.all([
                    section==='Сайты'?desktopClient.request<{
                        items: DesktopSite[];
                        nextCursor?: string | null;
                    }>('site.list', { ...filters, ...(cursor ? { cursor } : {}) }):Promise.resolve({items:[],nextCursor:null}),
                    desktopClient.request<Device>('device.status'),
                    managed ? desktopClient.request<SessionView>('session') : Promise.resolve(null),
                ]);
                if (!stopped) {
                    if (currentSession && session && (currentSession.principal.userId !== session.principal.userId || currentSession.principal.role !== session.principal.role))
                        changePage([null]);
                    else if(section==='Сайты') {
                        setSites(list.items);
                        setNextCursor(list.nextCursor ?? null);
                        setLoaded(true);
                    }
                    setDevice(status);
                    if (currentSession && JSON.stringify(currentSession) !== JSON.stringify(session)) {
                        setSession(currentSession);
                        if (!currentSession.capabilities.admin && ['Пользователи', 'Подключения', 'Исполнители', 'Расход ресурсов', 'Резервные копии'].includes(section))
                            setSection('Сайты');
                        if (!currentSession.capabilities.edit)
                            setEditorId(null);
                    }
                    setPollError('');
                }
                return {active:list.items.some(s=>['queued','running'].includes(s.job?.state??'')),key:JSON.stringify(list.items.map(s=>[s.id,s.revision,s.job?.state,s.job?.stage,s.job?.checkpointId]))};
            }
            catch (error) {
                if (!stopped) {
                    setPollError((error as Error).message);
                    setDevice(null);
                    if (managed && ['UNAUTHENTICATED', 'FORBIDDEN'].includes(String((error as {
                        code?: string;
                    }).code))) {
                        setSession(null);
                        setFilters({});
                        setFilterDraft({});
                        changePage([null]);
                        setCatalog({ styles: [], references: [] });
                        setEditorId(null);
                        setCreating(false);
                        setSection('Режим работы');
                    }
                }
                throw error;
            }
            finally {
                if (!stopped) {
                    setLoading(false);

                }
            }
        }
        const stop=pollLoop(poll,()=>document.visibilityState!=='hidden',document,window);
        return () => { stopped = true; stop(); };
    }, [refresh, managed, session, cursor, filters,section]);
    async function action(method: string, site: DesktopSite) {
        try {
            await desktopClient.request(method, method.startsWith('job.') ? { siteId: site.id } : { siteId: site.id, revisionId: site.draftId??site.publishedId });
            setActionFailure(current => current?.method === method && current.site.id === site.id ? null : current);
            setRefresh(value => value + 1);
        }
        catch (error) {
            setActionFailure({ message: (error as Error).message, method, site });
        }
    }
    return (<div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><img className="brand-mark" src={brandLogo} alt="" aria-hidden="true"/>Site Factory</div>
        <nav aria-label="Разделы">
          {['Сайты', 'Пачки', 'Референсы', ...(managed ? session?.capabilities.admin ? ['Пользователи', 'Подключения', 'Исполнители', 'Расход ресурсов', 'Резервные копии'] : [] : ['Устройство', 'Расход ресурсов', 'Резервные копии']), 'Режим работы'].map(name => (<button key={name} aria-current={section === name ? 'page' : undefined} onClick={() => { setSection(name); setEditorId(null); }}>{name}</button>))}
        </nav>
        <div className="sidebar-bottom">
          <span className={device?.available ? 'device-dot online' : 'device-dot'} aria-hidden="true"/>
          <span>{managed?'Общая очередь':device?.available ? 'Исполнитель доступен' : device ? 'Требуется настройка' : 'Нет связи'}</span>
          <p>{managed ? 'Общий реестр · рабочие устройства' : device?.mode === 'live' ? 'OpenAI · локальное хранение' : device?.mode === 'demo' ? 'Демо — без внешних сервисов' : 'Вызовы модели остановлены'}</p>
        </div>
      </aside>
      <main className={editedSite && section === 'Сайты' ? 'editing-main' : undefined}>
        <header className="topbar">
          <div>
            <h1>{section === 'Сайты' && editedSite ? editedSite.domain : section}</h1>
            {section === 'Сайты' ? <span className="muted">{managed ? `${siteCount(sites.length)} на странице · ${session?.principal.role ?? 'требуется вход'}` : editedSite ? `Правки сайта · ${device?.mode === 'live' ? 'OpenAI' : 'локальный режим'}` : loaded ? `${siteCount(sites.length)} на странице локального реестра` : 'Загрузка локального реестра'}</span> : null}
          </div>
          <div className="topbar-actions">
          <button onClick={()=>setRefresh(v=>v+1)}>Обновить</button>
          {section === 'Сайты' ? editedSite ? <button onClick={() => setEditorId(null)}>← Сайты</button> : <button className="primary" disabled={managed && !session} onClick={() => setCreating(true)}>Создать сайт</button> : null}
          </div>
        </header>
        <div className={editedSite && section === 'Сайты' ? 'workspace editor-workspace' : 'workspace'}>
          <Suspense fallback={<p role="status">Загрузка раздела…</p>}>
          {pollError ? <div role="alert" className="error-banner"><strong>Не удалось обновить состояние</strong><span>{pollError}</span><button onClick={() => setRefresh(value => value + 1)}>Обновить состояние</button></div> : null}
          {catalogError ? <div role="alert" className="error-banner"><strong>Не удалось загрузить референсы</strong><span>{catalogError}</span><button onClick={() => void loadCatalog().catch(() => { })}>Загрузить референсы повторно</button></div> : null}
          {actionFailure ? <div role="alert" className="error-banner"><strong>Не удалось выполнить операцию</strong><span>{actionFailure.message}</span><button onClick={() => void action(actionFailure.method, actionFailure.site)}>Повторить операцию</button><button onClick={() => setActionFailure(null)}>Закрыть сообщение</button></div> : null}
          {section === 'Расход ресурсов' && (!managed||session?.capabilities.admin)?<UsagePanel key={managed?session?.principal.userId:'local'}/>:section === 'Режим работы' ? <Login managed={managed} onStart={() => { setManaged(true); setSession(null); changePage([null]); setCatalog({ styles: [], references: [] }); setDevice(null); setLoaded(false); setPollError(''); setCatalogError(''); }} onConnected={value => { setSession(value); setSection('Сайты'); setRefresh(v => v + 1); }} onLocal={() => { setManaged(false); setSession(null); changePage([null]); setSection('Сайты'); setRefresh(v => v + 1); }}/> : section === 'Резервные копии' && (!managed || session?.capabilities.admin) ? <BackupSettings key={managed ? session?.principal.userId : 'local'} managed={managed} {...(session ? { principalId: session.principal.userId } : {})}/> : section === 'Пачки' ? <Batches key={`${managed ? 'managed' : 'local'}:${session?.principal.userId ?? ''}:${session?.principal.role ?? ''}`} admin={!!session?.capabilities.admin}/> : section === 'Пользователи' && session?.capabilities.admin ? <UsersSettings /> : section === 'Исполнители' && session?.capabilities.admin ? <WorkerList /> : section === 'Подключения' && session?.capabilities.admin ? <IntegrationsSettings /> : section === 'Сайты' ? editedSite ? (<SiteEditor key={editedSite.id} site={editedSite} managed={managed} canPublish={!managed || !!session?.capabilities.publish} {...(session ? { principal: session.principal } : {})} modelMode={managed&&session?.capabilities.edit?'managed':device?.mode ?? 'blocked'} onChanged={next => {
                if (next)
                    setSites(current => current.map(site => site.id === next.id ? { ...site, ...next } : site));
                setRefresh(value => value + 1);
            }}/>) : (<>
              <div className="context-line"><span>Реестр доменов</span><span className="muted">{managed ? 'Общие данные · задания выполняют подключённые устройства' : 'Создание → проверка → локальная версия'}</span></div>
              <form className="registry-filters" onSubmit={e => { e.preventDefault(); setFilters(filterDraft); changePage([null]); }}><label>Поиск домена<input value={filterDraft.domain ?? ''} onChange={e => setFilterDraft(p => ({ ...p, domain: e.target.value }))}/></label><label>Состояние сайта<select value={filterDraft.status ?? ''} onChange={e => setFilterDraft(p => ({ ...p, status: e.target.value }))}><option value="">Все состояния</option><option value="queued">В очереди</option><option value="completed">Завершён</option><option value="needs_attention">Нужна проверка</option></select></label><button>Применить фильтры</button></form>
 {usageSiteId?<><button onClick={()=>setUsageSiteId(null)}>Закрыть расход сайта</button><UsagePanel key={`${usageSiteId}:${session?.principal.userId??'local'}:${session?.principal.role??'admin'}`} siteId={usageSiteId}/></>:null}
 {!loaded && pollError ? <section className="registry unavailable"><h2>Реестр недоступен</h2><p>Список сайтов появится после восстановления связи с исполнителем.</p></section> : <SiteList onUsage={site=>setUsageSiteId(site.id)} {...(managed && session?.capabilities.publish ? { onPublication: (site: DesktopSite) => setPublicationId(site.id) } : {})} sites={sites} loading={loading} onCancel={site=>void action('job.cancel',site)} {...(session?{principal:session.principal}:{})} canEdit={!managed || !!session?.capabilities.edit} canRetry={true} managed={managed} onEdit={site => setEditorId(site.id)} onPreview={site => managed ? void action('preview.open', site) : setPreview(site)} onOpen={site => void action('preview.open', site)} onRetry={site => void action('job.retry', site)}/>}
              {(!managed || session) ? <nav className="row-actions" aria-label={managed ? "Страницы общего реестра" : "Страницы локального реестра"}>
                <button disabled={loading || pageCursors.length === 1} onClick={() => { setPollError(''); changePage(pageCursors.slice(0, -1)); }}>Предыдущая страница</button>
                <span aria-live="polite">Страница {pageCursors.length}</span>
                <button disabled={loading || !nextCursor} onClick={() => {
                    if (nextCursor) {
                        setPollError('');
                        changePage([...pageCursors, nextCursor]);
                    }
                }}>Следующая страница</button>
              </nav> : null}
              {managed && session && publicationSite ? <><button onClick={() => setPublicationId(null)}>Закрыть публикацию</button><PublicationPanel key={publicationSite.id} site={publicationSite} principal={session.principal} onChanged={() => setRefresh(v => v + 1)}/></> : null}
              <p className="workspace-note">{managed ? (session?.capabilities.publish ? 'Управляемый режим. Генерация требует запущенного устройства. Первая публикация продолжается автоматически при запущенном устройстве; DNS настраивается вручную. Исходники и копии доступны администратору в настольном приложении.' : 'Управляемый режим. Генерация требует запущенного устройства. Публикация зависит от настроек и прав доступа. Исходники и копии доступны администратору в настольном приложении.') : 'Локальные версии доступны на этом устройстве. Домены и внешний хостинг в демо не подключены.'}</p>
            </>) : section === 'Референсы' ? <ReferenceLibrary catalog={catalog} onChange={loadCatalog} canManage={!managed || !!session?.capabilities.admin} managed={managed}/> : !managed ? (<><section className="device-panel">
              <h2>{device?.available ? 'Исполнитель доступен' : 'Исполнитель недоступен'}</h2>
              <p>Это устройство создаёт и проверяет локальные сайты.</p>
              <dl><dt>Режим</dt><dd>{device?.mode === 'live' ? 'Реальная модель · локальные данные' : device?.mode === 'demo' ? 'Локальное демо' : 'Требуется настройка'}</dd><dt>Активные задания</dt><dd>{device ? `${device.activeJobs} из ${device.maxJobs}` : 'Нет связи'}</dd></dl>
              <p className="hint">При закрытии приложения текущая работа сохраняется. После запуска исполнение продолжится.</p>
            </section><ModelSettings device={device} onChanged={next => { setDevice(next); setRefresh(value => value + 1); }}/></>) : <p>Этот раздел недоступен для текущей роли.</p>}
          </Suspense>
        </div>
      </main>
      <Suspense fallback={<p role="status">Загрузка диалога…</p>}>
      {creating ? <CreateSiteDialog styles={catalog.styles} references={catalog.references} onClose={() => setCreating(false)} onCreated={() => {
                setCreating(false);
                if (managed)
                    changePage([null]);
                setRefresh(value => value + 1);
            }}/> : null}
      </Suspense>
      {preview ? <Screenshot site={preview} onClose={() => setPreview(null)}/> : null}
    </div>);
}
function Screenshot({ site, onClose }: {
    site: DesktopSite;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    const [width, setWidth] = useState(1440);
    const [url, setUrl] = useState('');
    const [error, setError] = useState('');
    useEffect(() => { ref.current?.showModal(); }, []);
    useEffect(() => {
        let active = true;
        setUrl('');
        setError('');
        void desktopClient.request<{
            dataUrl: string;
        }>('preview.screenshot', { siteId: site.id, revisionId: site.draftId??site.publishedId, width })
            .then(result => {
            if (active)
                setUrl(result.dataUrl);
        })
            .catch(error => {
            if (active)
                setError(error.message);
        });
        return () => { active = false; };
    }, [site.id, site.draftId,site.publishedId, width]);
    return (<dialog ref={ref} className="screenshot-dialog" onCancel={onClose} aria-labelledby="screenshot-title">
      <div className="preview-header">
        <div><h2 id="screenshot-title">{site.domain}</h2><p className="muted">Проверенный снимок Chromium</p></div>
        <div className="row-actions">
          {[375, 1440].map(value => <button key={value} aria-pressed={width === value} onClick={() => setWidth(value)}>{value} px</button>)}
          <button onClick={onClose} aria-label="Закрыть снимок">Закрыть</button>
        </div>
      </div>
      <div className="screenshot-surface">{error ? <p role="alert">{error}</p> : url ? <img src={url} alt={`Снимок сайта ${site.domain}`} style={{ maxWidth: width }}/> : <p role="status">Загрузка снимка…</p>}</div>
    </dialog>);
}
