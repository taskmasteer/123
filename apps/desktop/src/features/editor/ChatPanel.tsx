import React, { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../../../../packages/contracts/src/model.js';

export function ChatPanel({ messages, instruction, setInstruction, onSend, busy, refinement, onResetBase }: {
  messages: ChatMessage[]; instruction: string; setInstruction: (value: string) => void;
  onSend: () => void; busy: boolean; refinement: boolean; onResetBase: () => void;
}) {
  const history = useRef<HTMLDivElement>(null);
  useEffect(() => { history.current?.scrollTo({ top: history.current.scrollHeight }); }, [messages.length]);
  return (
    <section className="chat-panel" aria-labelledby="chat-title">
      <div className="chat-heading"><h2 id="chat-title">Чат сайта</h2><span className="muted">История сохраняется на устройстве</span></div>
      <div ref={history} className="chat-history" role="log" aria-label="История правок">
        {messages.length ? messages.map(message => <article key={message.id} className={`chat-message ${message.role}`}><strong>{message.role === 'user' ? 'Вы' : 'Демо-исполнитель'}</strong><p>{message.text}</p></article>) : <p className="muted">Опишите первую правку. Проверенный результат появится слева.</p>}
      </div>
      <form className="chat-compose" onSubmit={event => { event.preventDefault(); onSend(); }}>
        <div className="compose-base">{refinement ? 'База: выбранный вариант' : 'База: текущий черновик'}{refinement ? <button type="button" onClick={onResetBase}>Сбросить уточнение</button> : null}</div>
        <label htmlFor="edit-instruction">Инструкция для правки</label>
        <textarea id="edit-instruction" rows={3} maxLength={8000} value={instruction} onChange={event => setInstruction(event.target.value)} aria-describedby="demo-edit-hint" placeholder="Новый заголовок на английском" />
        <p id="demo-edit-hint" className="compose-hint">Демо заменяет только главный заголовок введённым текстом. Настоящая модель не подключена.</p>
        <button className="primary" disabled={busy || !instruction.trim()} type="submit">Отправить</button>
      </form>
    </section>
  );
}
