import {Button} from '../../components/ui/button.js';
import {pollLoop} from '../../lib/polling.js';
import {canCancelJob} from '../sites/SiteList.js';
import React, { useEffect, useState } from 'react';
import type { ChatMessage, Site, Principal } from '../../../../../packages/contracts/src/model.js';
import type { Candidate, PublishIntent } from '../../../../../packages/contracts/src/editing.js';
import type { CandidateView } from '../../../../../packages/contracts/src/http.js';
import type { DesktopSite } from '../sites/SiteList.js';
import { desktopClient } from '../../lib/desktop-client.js';
import { ChatPanel } from './ChatPanel.js';
import { PreviewComparison } from './PreviewComparison.js';
import { VisualEditor } from './VisualEditor.js';
import { PublicationPanel } from '../sites/PublicationPanel.js';
import { VersionHistory } from '../history/VersionHistory.js';
import { SourceFiles } from '../files/SourceFiles.js';
type Review = {
    candidates: (Candidate | CandidateView)[];
    publication: PublishIntent | null;
};
const statuses: Record<Candidate['status'], string> = { queued: 'В очереди', running: 'В работе', checking: 'Проверка', ready: 'Готов к проверке', accepted: 'Принят в черновик', rejected: 'Отклонён', conflict: 'Конфликт версий', failed: 'Правка не завершена' };
export function SiteEditor({ site, onChanged, modelMode, canPublish = true, managed = false, principal,showPublicationHistory=true }: {
    site: DesktopSite;
    onChanged: (site?: Site) => void;
    modelMode: 'demo' | 'live' | 'blocked' | 'managed';
    canPublish?: boolean;
    managed?: boolean;
    principal?: Principal;
    showPublicationHistory?: boolean;
}) {
    const admin = !managed || principal?.role === 'admin';
    const [sourceRevision, setSourceRevision] = useState<string | null>(null);
    const [review, setReview] = useState<Review>({ candidates: [], publication: null });
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [instruction, setInstruction] = useState('');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [refinementId, setRefinementId] = useState<string | null>(null);
    const [pollError, setPollError] = useState('');
    const [actionError, setActionError] = useState<{
        message: string;
        method: string;
    } | null>(null);
    const [busy, setBusy] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const selected = review.candidates.find(candidate => candidate.id === selectedId) ?? review.candidates.at(-1);
    const active = review.candidates.some(candidate => ['queued', 'running', 'checking'].includes(candidate.status)) || review.publication?.state === 'pending'||!!site.operation||['queued','running','paused','waiting_provider'].includes(site.job?.state??'');
    const cancellable={...site,job:review.candidates.find(c=>['queued','running','checking'].includes(c.status))?.job??site.job} as DesktopSite;
    const canReview = selected?.status === 'ready' && selected.baseRevision === site.revision;
    const hasDraft = !!site.draftId && site.draftId !== site.publishedId;
    const previewable = selected && ['ready', 'accepted', 'conflict'].includes(selected.status);
    const pendingVisual = review.candidates.find(c => c.visualSave?.state === 'pending');
    const parentIndex = selected ? review.candidates.findIndex(c => c.id === selected.parentRevisionId) : -1;
    useEffect(() => {
        let stopped = false;
        async function poll() {
            try {
                const [next, chat] = await Promise.all([
                    desktopClient.request<Review>('edit.list', { siteId: site.id }),
                    desktopClient.request<ChatMessage[]>('chat.list', { siteId: site.id }),
                ]);
                if (!stopped) {
                    setReview(next);
                    setMessages(chat);
                    setPollError('');
                }
                return {active:next.candidates.some(c=>['queued','running','checking'].includes(c.status))||next.publication?.state==='pending',key:JSON.stringify(next)};
            }
            catch (error) {
                if (!stopped)
                    setPollError((error as Error).message);
                throw error;
            }
        }
        const stop=pollLoop(poll,()=>document.visibilityState!=='hidden',document,window);
        return () => { stopped = true; stop(); };
    }, [site.id, refresh]);
    async function act(method: string, params: Record<string, unknown>) {
        setBusy(true);
        try {
            const result = await desktopClient.request<Site | {
                ok: true;
            }>(method, { siteId: site.id, ...params });
            setActionError(current => current?.method === method ? null : current);
            if (method === 'edit.request') {
                setInstruction('');
                setRefinementId(null);
                setSelectedId(null);
            }
            if (method === 'edit.accept' || method === 'site.publish')
                onChanged(result as Site);
            else
                onChanged();
            setRefresh(value => value + 1);
        }
        catch (error) {
            setActionError({ message: (error as Error).message, method });
            if(['FORBIDDEN','UNAUTHENTICATED'].includes(String((error as {code?:string}).code)))onChanged();
        }
        finally {
            setBusy(false);
        }
    }
    function retryCurrentBase() {
        setRefinementId(null);
        const message = selected && 'instruction' in selected ? selected.instruction : selected && (selected as Candidate).job.edit?.instruction;
        if (message)
            setInstruction(message);
        document.getElementById('edit-instruction')?.focus();
    }
    return (<section className="site-editor" aria-label={`Правки ${site.domain}`}>
      <div className="editor-statusbar">
        <div><strong>{hasDraft ? 'Есть принятый черновик' : review.publication?.state === 'completed' ? managed ? 'Черновик опубликован' : 'Черновик опубликован локально' : 'Опубликованная версия сохранена'}</strong><span className="muted">{hasDraft ? 'Опубликованный сайт не изменён. ' : ''}Версия {site.revision}{managed ? '' : ' · внешний хостинг не подключён'}</span></div>
        {!managed ? <Button className={hasDraft ? 'primary' : ''} disabled={!canPublish || !hasDraft || busy || (active && review.publication?.state !== 'pending')} onClick={() => void act('site.publish', { expectedRevision: review.publication?.state === 'pending' ? review.publication.expectedRevision : site.revision })}>Опубликовать</Button> : null}
      </div>
      {managed && canPublish && principal ? <PublicationPanel site={site} principal={principal} onChanged={() => onChanged()}/> : null}
      <Button onClick={()=>setRefresh(value=>value+1)}>Обновить чат</Button>
      {site.operation==='publication'?<p role="status">Ожидается подтверждение публикации. Черновик доступен для просмотра.</p>:null}
      {canCancelJob(cancellable,principal,managed)?<Button disabled={busy} onClick={()=>void act('job.cancel',{})}>Отменить текущее задание</Button>:null}
      {pollError ? <div className="error-banner" role="alert"><span>{pollError}</span></div> : null}
      {actionError ? <div className="error-banner" role="alert"><span>{actionError.message}</span><Button onClick={() => setActionError(null)}>Закрыть сообщение</Button></div> : null}
      <VisualEditor key={`${site.id}:${principal?.userId ?? 'demo'}:${managed}`} site={site} {...(principal ? { principal } : {})} {...(pendingVisual ? { pendingSaveId: pendingVisual.id } : {})} blocked={active && !pendingVisual} onChanged={() => onChanged()}/>
      <div className="editor-layout">
        <div className="editor-review">
          <div className="candidate-toolbar">
            <label htmlFor="candidate-select">Вариант</label>
            <select id="candidate-select" value={selected?.id ?? ''} disabled={!review.candidates.length} onChange={event => { setSelectedId(event.target.value); setRefinementId(null); }}>
              {!review.candidates.length ? <option value="">Пока нет правок</option> : review.candidates.map((candidate, index) => <option key={candidate.id} value={candidate.id}>{`Вариант ${index + 1} · ${statuses[candidate.status]}`}</option>)}
            </select>
          </div>
          {managed ? <div className="row-actions"><Button disabled={busy || !(site.draftId ?? site.publishedId)} onClick={() => void act('preview.open', { revisionId: previewable ? selected.parentRevisionId : site.draftId ?? site.publishedId })}>Открыть исходную версию</Button><Button disabled={busy || !previewable} onClick={() => void act('preview.open', { revisionId: selected?.id })}>Открыть вариант</Button><p className="hint">Приватный предпросмотр проверенного варианта.</p></div> : <PreviewComparison siteId={site.id} domain={site.domain} beforeId={previewable ? selected.parentRevisionId : site.draftId ?? site.publishedId} afterId={previewable ? selected.id : null} {...(previewable ? { candidateId: selected.id } : {})}/>}
          <div className="candidate-decision">
            <strong>{selected ? `Вариант ${review.candidates.indexOf(selected) + 1} · ${statuses[selected.status]}` : 'Первая правка'}</strong>
            {parentIndex >= 0 ? <p className="hint">Уточнение варианта {parentIndex + 1}. Изменения построены на его файлах.</p> : null}
            <p>{selected?.summary || (active ? 'Дождитесь завершения или отмените текущую правку.' : 'Отправьте инструкцию, чтобы подготовить отдельный вариант сайта.')}</p>
            {selected?.validation?.ok ? <span className="badge success">✓ Проверки пройдены · 375 и 1440 px</span> : null}
            {selected?.status === 'conflict' || (selected?.status === 'ready' && !canReview) ? <p className="conflict-note">Черновик изменился. Вариант сохранён отдельно.</p> : null}
            <div className="decision-actions">
              <Button disabled={!canReview || busy || active} onClick={() => { setRefinementId(selected!.id); document.getElementById('edit-instruction')?.focus(); }}>Уточнить</Button>
              <Button className="primary" disabled={!canReview || busy || active} onClick={() => void act('edit.accept', { candidateId: selected!.id, expectedRevision: site.revision })}>Принять в черновик</Button>
              <Button disabled={!selected || !['ready', 'conflict', 'failed'].includes(selected.status) || busy} onClick={() => { setRefinementId(null); void act('edit.reject', { candidateId: selected!.id }); }}>Отклонить</Button>
            </div>
            {selected?.status === 'conflict' || (selected?.status === 'ready' && !canReview) ? <Button disabled={busy || active} onClick={retryCurrentBase}>Повторить на актуальном черновике</Button> : null}
          </div>
        </div>
        <ChatPanel modelMode={modelMode} messages={messages} instruction={instruction} setInstruction={setInstruction} busy={busy || active} refinement={!!refinementId} onResetBase={() => setRefinementId(null)} onSend={() => void act('edit.request', { instruction, expectedRevision: site.revision, ...(refinementId ? { candidateId: refinementId } : {}) })}/>
      </div>
      {admin && (site.draftId ?? site.publishedId) ? <Button className="source-open" onClick={() => setSourceRevision(site.draftId ?? site.publishedId)}>Исходники текущей версии</Button> : null}
      {showPublicationHistory?<VersionHistory site={site} canPublish={canPublish} onChanged={() => onChanged()} {...(admin ? { onSource: (id: string) => setSourceRevision(id) } : {})}/>:null}
      {admin && sourceRevision ? <SourceFiles key={site.id + sourceRevision} siteId={site.id} revisionId={sourceRevision}/> : null}
    </section>);
}
