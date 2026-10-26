import React, { useEffect, useState } from 'react';
import { desktopClient } from '../../lib/desktop-client.js';

export function PreviewComparison({ siteId, domain, beforeId, afterId, candidateId }: {
  siteId: string; domain: string; beforeId: string | null; afterId: string | null; candidateId?: string;
}) {
  const [width, setWidth] = useState(1440);
  return (
    <section className="comparison" aria-label="Сравнение версий">
      <div className="comparison-toolbar"><span>Проверенные снимки Chromium</span><div className="row-actions">
        {[375, 1440].map(value => <button key={value} aria-pressed={width === value} onClick={() => setWidth(value)}>{value} px</button>)}
      </div></div>
      <div className="comparison-images">
        <Snapshot key={`before-${beforeId}-${width}`} title="До" domain={domain} siteId={siteId} revisionId={beforeId} width={width} candidateId={candidateId} />
        <Snapshot key={`after-${afterId}-${width}`} title="После" domain={domain} siteId={siteId} revisionId={afterId} width={width} candidateId={candidateId} />
      </div>
      <p className="comparison-note">Сравните текст и композицию. Принятие сохраняет черновик; публикация выполняется отдельно.</p>
    </section>
  );
}
function Snapshot({ title, domain, siteId, revisionId, width, candidateId }: {
  title: string; domain: string; siteId: string; revisionId: string | null; width: number; candidateId?: string | undefined;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!revisionId) return;
    let active = true;
    setUrl(''); setError('');
    void desktopClient.request<{ dataUrl: string }>('preview.screenshot', { siteId, revisionId, width, ...(candidateId ? { candidateId } : {}) })
      .then(result => { if (active) setUrl(result.dataUrl); })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [siteId, revisionId, width, candidateId, retry]);
  return <figure className="comparison-frame"><figcaption>{title}</figcaption><div className="comparison-scroll">
    {!revisionId ? <div className="comparison-placeholder">Здесь появится проверенный вариант</div> : error ? <div role="alert"><p>{error}</p><button onClick={() => setRetry(value => value + 1)}>Повторить снимок</button></div> : url ? <img src={url} alt={`${title} — ${domain}`} style={{ maxWidth: width }} /> : <p role="status">Загрузка снимка…</p>}
  </div></figure>;
}
