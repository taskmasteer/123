import React, { useEffect, useRef, useState } from 'react';
import { desktopClient } from './lib/desktop-client.js';
import { CreateSiteDialog } from './features/sites/CreateSiteDialog.js';
import { SiteList } from './features/sites/SiteList.js';
import type { DesktopSite } from './features/sites/SiteList.js';
import { ReferenceLibrary } from './features/references/ReferenceLibrary.js';
import type { Catalog } from './features/references/ReferenceLibrary.js';
import { SiteEditor } from './features/editor/SiteEditor.js';
import './app.css';

type Device = { available: boolean; activeJobs: number; maxJobs: number };
export default function App() {
  const [section, setSection] = useState('Сайты');
  const [sites, setSites] = useState<DesktopSite[]>([]);
  const [catalog, setCatalog] = useState<Catalog>({ styles: [], references: [] });
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [pollError, setPollError] = useState('');
  const [device, setDevice] = useState<Device | null>(null);
  const [creating, setCreating] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [actionFailure, setActionFailure] = useState<{ message: string; method: string; site: DesktopSite } | null>(null);
  const [preview, setPreview] = useState<DesktopSite | null>(null);
  const [editorId, setEditorId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const editedSite = sites.find(site => site.id === editorId);

  async function loadCatalog() {
    try {
      setCatalog(await desktopClient.request<Catalog>('catalog.list'));
      setCatalogError('');
    } catch (error) {
      setCatalogError((error as Error).message);
      throw error;
    }
  }
  useEffect(() => { void loadCatalog().catch(() => {}); }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const [list, status] = await Promise.all([
          desktopClient.request<{ items: DesktopSite[] }>('site.list'),
          desktopClient.request<Device>('device.status'),
        ]);
        if (!stopped) {
          setSites(list.items);
          setLoaded(true);
          setDevice(status);
          setPollError('');
        }
      } catch (error) {
        if (!stopped) { setPollError((error as Error).message); setDevice(null); }
      } finally {
        if (!stopped) { setLoading(false); timer = setTimeout(() => void poll(), 600); }
      }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh]);
  async function action(method: string, site: DesktopSite) {
    try {
      await desktopClient.request(method, method === 'job.retry' ? { siteId: site.id } : { siteId: site.id, revisionId: site.publishedId });
      setActionFailure(current => current?.method === method && current.site.id === site.id ? null : current);
      setRefresh(value => value + 1);
    } catch (error) { setActionFailure({ message: (error as Error).message, method, site }); }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">▦</span>Site Factory</div>
        <nav aria-label="Разделы">
          {['Сайты', 'Референсы', 'Устройство'].map(name => (
            <button key={name} aria-current={section === name ? 'page' : undefined} onClick={() => { setSection(name); setEditorId(null); }}>{name}</button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className={device ? 'device-dot online' : 'device-dot'} aria-hidden="true" />
          <span>{device ? 'Исполнитель доступен' : 'Нет связи'}</span>
          <p>Демо — без внешних сервисов</p>
        </div>
      </aside>
      <main className={editedSite && section === 'Сайты' ? 'editing-main' : undefined}>
        <header className="topbar">
          <div>
            <h1>{section === 'Сайты' && editedSite ? editedSite.domain : section}</h1>
            {section === 'Сайты' ? <span className="muted">{editedSite ? 'Правки сайта · локальное демо' : loaded ? `${sites.length} сайтов в локальном реестре` : 'Загрузка локального реестра'}</span> : null}
          </div>
          {section === 'Сайты' ? editedSite ? <button onClick={() => setEditorId(null)}>← Сайты</button> : <button className="primary" onClick={() => setCreating(true)}>Создать сайт</button> : null}
        </header>
        <div className={editedSite && section === 'Сайты' ? 'workspace editor-workspace' : 'workspace'}>
          {pollError ? <div role="alert" className="error-banner"><strong>Не удалось обновить состояние</strong><span>{pollError}</span><button onClick={() => setRefresh(value => value + 1)}>Обновить состояние</button></div> : null}
          {catalogError ? <div role="alert" className="error-banner"><strong>Не удалось загрузить референсы</strong><span>{catalogError}</span><button onClick={() => void loadCatalog().catch(() => {})}>Загрузить референсы повторно</button></div> : null}
          {actionFailure ? <div role="alert" className="error-banner"><strong>Не удалось выполнить операцию</strong><span>{actionFailure.message}</span><button onClick={() => void action(actionFailure.method, actionFailure.site)}>Повторить операцию</button><button onClick={() => setActionFailure(null)}>Закрыть сообщение</button></div> : null}
          {section === 'Сайты' ? editedSite ? (
            <SiteEditor key={editedSite.id} site={editedSite} onChanged={next => {
              if (next) setSites(current => current.map(site => site.id === next.id ? { ...site, ...next } : site));
              setRefresh(value => value + 1);
            }} />
          ) : (
            <>
              <div className="context-line"><span>Реестр доменов</span><span className="muted">Создание → проверка → локальная версия</span></div>
              {!loaded && pollError ? <section className="registry unavailable"><h2>Реестр недоступен</h2><p>Список сайтов появится после восстановления связи с исполнителем.</p></section> : <SiteList sites={sites} loading={loading} onEdit={site => setEditorId(site.id)} onPreview={setPreview} onOpen={site => void action('preview.open', site)} onRetry={site => void action('job.retry', site)} />}
              <p className="workspace-note">Локальные версии доступны на этом устройстве. Домены и внешний хостинг в демо не подключены.</p>
            </>
          ) : section === 'Референсы' ? <ReferenceLibrary catalog={catalog} onChange={loadCatalog} /> : (
            <section className="device-panel">
              <h2>{device ? 'Исполнитель доступен' : 'Исполнитель недоступен'}</h2>
              <p>Это устройство создаёт и проверяет локальные сайты.</p>
              <dl><dt>Режим</dt><dd>Локальное демо</dd><dt>Активные задания</dt><dd>{device ? `${device.activeJobs} из ${device.maxJobs}` : 'Нет связи'}</dd><dt>Модель и публикация</dt><dd>Демонстрационные адаптеры, без внешних запросов</dd></dl>
              <p className="hint">При закрытии приложения текущая работа сохраняется. После запуска исполнение продолжится.</p>
            </section>
          )}
        </div>
      </main>
      {creating ? <CreateSiteDialog styles={catalog.styles} references={catalog.references} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); setRefresh(value => value + 1); }} /> : null}
      {preview ? <Screenshot site={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}
function Screenshot({ site, onClose }: { site: DesktopSite; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [width, setWidth] = useState(1440);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    setUrl(''); setError('');
    void desktopClient.request<{ dataUrl: string }>('preview.screenshot', { siteId: site.id, revisionId: site.publishedId, width })
      .then(result => { if (active) setUrl(result.dataUrl); })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [site.id, site.publishedId, width]);
  return (
    <dialog ref={ref} className="screenshot-dialog" onCancel={onClose} aria-labelledby="screenshot-title">
      <div className="preview-header">
        <div><h2 id="screenshot-title">{site.domain}</h2><p className="muted">Проверенный снимок Chromium</p></div>
        <div className="row-actions">
          {[375, 1440].map(value => <button key={value} aria-pressed={width === value} onClick={() => setWidth(value)}>{value} px</button>)}
          <button onClick={onClose} aria-label="Закрыть снимок">Закрыть</button>
        </div>
      </div>
      <div className="screenshot-surface">{error ? <p role="alert">{error}</p> : url ? <img src={url} alt={`Снимок сайта ${site.domain}`} style={{ maxWidth: width }} /> : <p role="status">Загрузка снимка…</p>}</div>
    </dialog>
  );
}
