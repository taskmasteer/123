import React, { useEffect, useState } from 'react';
import type { ChatMessage, Site } from '../../../../../packages/contracts/src/model.js';
import type { Candidate, PublishIntent } from '../../../../../packages/contracts/src/editing.js';
import type { DesktopSite } from '../sites/SiteList.js';
import { desktopClient } from '../../lib/desktop-client.js';
import { ChatPanel } from './ChatPanel.js';
import { PreviewComparison } from './PreviewComparison.js';

type Review = { candidates: Candidate[]; publication: PublishIntent | null };
const statuses: Record<Candidate['status'], string> = { queued: 'В очереди', running: 'В работе', checking: 'Проверка', ready: 'Готов к проверке', accepted: 'Принят в черновик', rejected: 'Отклонён', conflict: 'Конфликт версий', failed: 'Правка не завершена' };

export function SiteEditor({ site, onChanged, modelMode }: { site: DesktopSite; onChanged: (site?: Site) => void;modelMode:'demo'|'live'|'blocked' }) {
  const [review, setReview] = useState<Review>({ candidates: [], publication: null });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [instruction, setInstruction] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refinementId, setRefinementId] = useState<string | null>(null);
  const [pollError, setPollError] = useState('');
  const [actionError, setActionError] = useState<{ message: string; method: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const selected = review.candidates.find(candidate => candidate.id === selectedId) ?? review.candidates.at(-1);
  const active = review.candidates.some(candidate => ['queued', 'running', 'checking', 'failed'].includes(candidate.status)) || review.publication?.state === 'pending';
  const canReview = selected?.status === 'ready' && selected.baseRevision === site.revision;
  const hasDraft = !!site.draftId && site.draftId !== site.publishedId;
  const previewable = selected && ['ready', 'accepted', 'conflict'].includes(selected.status);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const [next, chat] = await Promise.all([
          desktopClient.request<Review>('edit.list', { siteId: site.id }),
          desktopClient.request<ChatMessage[]>('chat.list', { siteId: site.id }),
        ]);
        if (!stopped) { setReview(next); setMessages(chat); setPollError(''); }
      } catch (error) { if (!stopped) setPollError((error as Error).message); }
      finally { if (!stopped) timer = setTimeout(() => void poll(), 700); }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [site.id, refresh]);

  async function act(method: string, params: Record<string, unknown>) {
    setBusy(true);
    try {
      const result = await desktopClient.request<Site | { ok: true }>(method, { siteId: site.id, ...params });
      setActionError(current => current?.method === method ? null : current);
      if (method === 'edit.request') { setInstruction(''); setRefinementId(null); setSelectedId(null); }
      if (method === 'edit.accept' || method === 'site.publish') onChanged(result as Site);
      else onChanged();
      setRefresh(value => value + 1);
    } catch (error) { setActionError({ message: (error as Error).message, method }); }
    finally { setBusy(false); }
  }
  function retryCurrentBase() {
    setRefinementId(null);
    const message = selected?.job.edit?.instruction;
    if (message) setInstruction(message);
    document.getElementById('edit-instruction')?.focus();
  }
  return (
    <section className="site-editor" aria-label={`Правки ${site.domain}`}>
      <div className="editor-statusbar">
        <div><strong>{hasDraft ? 'Есть принятый черновик' : review.publication?.state === 'completed' ? 'Черновик опубликован локально' : 'Опубликованная версия сохранена'}</strong><span className="muted">{hasDraft ? 'Опубликованный сайт не изменён. ' : ''}Версия {site.revision} · внешний хостинг не подключён</span></div>
        <button className={hasDraft ? 'primary' : ''} disabled={!hasDraft || busy || (active && review.publication?.state !== 'pending')} onClick={() => void act('site.publish', { expectedRevision: review.publication?.state === 'pending' ? review.publication.expectedRevision : site.revision })}>Опубликовать</button>
      </div>
      {pollError ? <div className="error-banner" role="alert"><span>{pollError}</span><button onClick={() => setRefresh(value => value + 1)}>Обновить чат</button></div> : null}
      {actionError ? <div className="error-banner" role="alert"><span>{actionError.message}</span><button onClick={() => setActionError(null)}>Закрыть сообщение</button></div> : null}
      <div className="editor-layout">
        <div className="editor-review">
          <div className="candidate-toolbar">
            <label htmlFor="candidate-select">Вариант</label>
            <select id="candidate-select" value={selected?.id ?? ''} disabled={!review.candidates.length} onChange={event => { setSelectedId(event.target.value); setRefinementId(null); }}>
              {!review.candidates.length ? <option value="">Пока нет правок</option> : review.candidates.map((candidate, index) => <option key={candidate.id} value={candidate.id}>{`Вариант ${index + 1} · ${statuses[candidate.status]}`}</option>)}
            </select>
          </div>
          <PreviewComparison siteId={site.id} domain={site.domain} beforeId={previewable ? selected.parentRevisionId : site.draftId ?? site.publishedId} afterId={previewable ? selected.id : null} {...(previewable ? { candidateId: selected.id } : {})} />
          <div className="candidate-decision">
            <strong>{selected ? `Вариант ${review.candidates.indexOf(selected) + 1} · ${statuses[selected.status]}` : 'Первая правка'}</strong>
            <p>{selected?.summary || (active ? 'Дождитесь завершения или отмените текущую правку.' : 'Отправьте инструкцию, чтобы подготовить отдельный вариант сайта.')}</p>
            {selected?.validation?.ok ? <span className="badge success">✓ Проверки пройдены · 375 и 1440 px</span> : null}
            {selected?.status === 'conflict' || (selected?.status === 'ready' && !canReview) ? <p className="conflict-note">Черновик изменился. Вариант сохранён отдельно.</p> : null}
            <div className="decision-actions">
              <button disabled={!canReview || busy || active} onClick={() => { setRefinementId(selected!.id); document.getElementById('edit-instruction')?.focus(); }}>Уточнить</button>
              <button className="primary" disabled={!canReview || busy || active} onClick={() => void act('edit.accept', { candidateId: selected!.id, expectedRevision: site.revision })}>Принять в черновик</button>
              <button disabled={!selected || !['ready', 'conflict', 'failed'].includes(selected.status) || busy} onClick={() => { setRefinementId(null); void act('edit.reject', { candidateId: selected!.id }); }}>Отклонить</button>
            </div>
            {selected?.status === 'conflict' || (selected?.status === 'ready' && !canReview) ? <button disabled={busy || active} onClick={retryCurrentBase}>Повторить на актуальном черновике</button> : null}
          </div>
        </div>
        <ChatPanel modelMode={modelMode} messages={messages} instruction={instruction} setInstruction={setInstruction} busy={busy || active} refinement={!!refinementId} onResetBase={() => setRefinementId(null)} onSend={() => void act('edit.request', { instruction, expectedRevision: site.revision, ...(refinementId ? { candidateId: refinementId } : {}) })} />
      </div>
    </section>
  );
}
