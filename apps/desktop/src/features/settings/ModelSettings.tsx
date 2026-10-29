import React, { useState } from 'react';
import { desktopClient } from '../../lib/desktop-client.js';
export type DeviceStatus = {
    mode: 'demo' | 'live' | 'blocked';
    available: boolean;
    activeJobs: number;
    maxJobs: number;
    model: string | null;
    imageModel?: string | null;
    images: 'enabled' | 'disabled';
    storage: 'local';
    publication: 'demo';
    usage?: {
        inputTokens: number;
        outputTokens: number;
        uncertainRequests?:number;
    };
};
export function ModelSettings({ device, onChanged,managed=false }: {
    managed?:boolean;
    device: DeviceStatus | null;
    onChanged: (device: DeviceStatus) => void;
}) {
    const [key, setKey] = useState(''), [model, setModel] = useState(device?.model ?? ''), [imageModel, setImageModel] = useState(device?.imageModel ?? '');
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
    async function configure(action: 'save' | 'delete' | 'demo') {
        const request = action === 'save' ? { action, apiKey: key, model: model.trim(), ...(imageModel.trim() ? { imageModel: imageModel.trim() } : {}) } : { action };
        // Clear the input before awaiting native storage, including error paths. Never load secrets back.
        setKey('');
        setBusy(true);
        setError('');
        setMessage('');
        try {
            const next = await desktopClient.modelSettings<DeviceStatus>(request);
            onChanged(next);
            setMessage(action === 'save' ? 'Настройки сохранены. Доступность моделей проверится при следующем задании.' : action === 'delete' ? 'Ключ удалён. Новые запросы остановлены.' : 'Демонстрационный режим включён.');
        }
        catch (error) {
            setError((error as Error).message);
        }
        finally {
            setBusy(false);
        }
    }
    return <section className="model-settings" aria-labelledby="model-settings-title">
  <div className="settings-heading"><h2 id="model-settings-title">Модель на этом устройстве</h2><p>Ключ хранится в Windows Credential Manager или macOS Keychain. Он не возвращается в интерфейс.</p></div>
  <dl className="model-status"><dt>Модель</dt><dd>{device?.mode === 'live' ? `OpenAI · ${device.model}` : device?.mode === 'demo' ? 'Демонстрационная модель' : 'Модель отключена'}</dd><dt>Изображения</dt><dd>{device?.images === 'enabled' ? 'Не более одной иллюстрации · вероятность 10%' : 'Изображения отключены'}</dd><dt>Хранение</dt><dd>{managed?'Общее приватное хранилище':'Локально на устройстве'}</dd><dt>Хостинг</dt><dd>{managed?'Зависит от настроек установки':'Демонстрационная публикация'}</dd></dl>
  <form onSubmit={event => { event.preventDefault(); void configure('save'); }}>
   <label htmlFor="openai-key">API-ключ OpenAI</label><input id="openai-key" type="password" autoComplete="off" spellCheck={false} maxLength={4096} value={key} onChange={event => setKey(event.target.value)} placeholder="Введите новый ключ" required/>
   <div className="model-fields"><div><label htmlFor="text-model">Текстовая модель</label><input id="text-model" value={model} onChange={event => setModel(event.target.value)} maxLength={128} pattern="[a-zA-Z0-9][a-zA-Z0-9._:\-]*" required placeholder="ID доступной вашему аккаунту модели"/></div><div><label htmlFor="image-model">Модель изображений · необязательно</label><input id="image-model" value={imageModel} onChange={event => setImageModel(event.target.value)} maxLength={128} placeholder="Пусто — изображения отключены"/></div></div>
   <p className="hint">Укажите точные ID доступных аккаунту моделей. Автоматической подмены нет. Подключение разрешает платные запросы для новых заданий; без модели изображений вызовов Images API не будет.</p>
   <div className="settings-actions"><button type="submit" className="primary" disabled={busy || !key || !model.trim()}>Сохранить и подключить</button><button type="button" disabled={busy} onClick={() => void configure('delete')}>Удалить ключ</button>{!managed?<button type="button" disabled={busy} onClick={() => void configure('demo')}>Включить демо</button>:null}</div>
   {device?.usage?.uncertainRequests?<p>У {device.usage.uncertainRequests} предыдущих запросов расход токенов и стоимость неизвестны. Они не входят в подтверждённые токены.</p>:null}
  </form>
  {error ? <p role="alert" className="error-text">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
  {device?.usage ? <p className="hint">Последнее задание · входные токены: {device.usage.inputTokens} · выходные: {device.usage.outputTokens}</p> : null}
 </section>;
}
