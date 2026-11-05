import {Textarea} from '../../components/ui/textarea.js';
import {Button} from '../../components/ui/button.js';
import React, { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../../../../packages/contracts/src/model.js';

export function ChatPanel({ messages, instruction, setInstruction, onSend, busy, refinement, onResetBase,modelMode }: {
  messages: ChatMessage[]; instruction: string; setInstruction: (value: string) => void;
  onSend: () => void; busy: boolean; refinement: boolean; onResetBase: () => void;
  modelMode:'demo'|'live'|'blocked'|'managed';
}) {
  const history = useRef<HTMLDivElement>(null);
  useEffect(() => { history.current?.scrollTo({ top: history.current.scrollHeight }); }, [messages.length]);
  return (
    <section className="chat-panel" aria-labelledby="chat-title">
      <div className="chat-heading"><h2 id="chat-title">Чат сайта</h2><span className="muted">История сохраняется вместе с сайтом</span></div>
      <div ref={history} className="chat-history" role="log" aria-label="История правок">
        {messages.length ? messages.map(message => <article key={message.id} className={`chat-message ${message.role}`}><strong>{message.role === 'user' ? 'Вы' : 'Исполнитель'}</strong><p>{message.text}</p></article>) : <p className="muted">Опишите первую правку. Проверенный результат появится слева.</p>}
      </div>
      <form className="chat-compose" onSubmit={event => { event.preventDefault(); onSend(); }}>
        <div className="compose-base">{refinement ? 'База: выбранный вариант' : 'База: текущий черновик'}{refinement ? <Button type="button" onClick={onResetBase}>Сбросить уточнение</Button> : null}</div>
        <label htmlFor="edit-instruction">Инструкция для правки</label>
        <Textarea id="edit-instruction" rows={3} maxLength={8000} value={instruction} onChange={event => setInstruction(event.target.value)} aria-describedby="demo-edit-hint" placeholder="Новый заголовок на английском" />
        <p id="demo-edit-hint" className="compose-hint">{modelMode==='managed'?'Правка отправится в общую очередь. Для выполнения требуется рабочее устройство; локальные ключи панели не нужны.':modelMode==='live'?'OpenAI редактирует текущие файлы. Проверьте вариант перед принятием.':modelMode==='demo'?'Демо заменяет только главный заголовок введённым текстом. Настоящая модель не подключена.':'Модель отключена. Настройте её в разделе «Устройство».'}</p>
        <Button className="primary" disabled={busy || !instruction.trim() || modelMode==='blocked'} type="submit">Отправить</Button>
      </form>
    </section>
  );
}
