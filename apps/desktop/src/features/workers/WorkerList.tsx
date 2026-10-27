import React, { useEffect, useState } from 'react';
import { desktopClient } from '../../lib/desktop-client.js';
import { ModelSettings, type DeviceStatus } from '../settings/ModelSettings.js';
interface WorkerView {
    id: string;
    name: string;
    paused: boolean;
    revoked: boolean;
    lastHeartbeat: number | null;
    jobs: {
        id: string;
        siteId: string;
        stage: string;
        state: string;
    }[];
}
interface NativeStatus {
    workerId: string | null;
    name: string | null;
    origin: string | null;
    enrolled: boolean;
    running: boolean;
    error: string | null;
}
export function WorkerList() {
    const [workers, setWorkers] = useState<WorkerView[]>([]), [native, setNative] = useState<NativeStatus | null>(null), [device, setDevice] = useState<DeviceStatus | null>(null);
    const [name, setName] = useState('Это устройство'), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    async function refresh() { setWorkers(await desktopClient.request<WorkerView[]>('worker.list')); }
    useEffect(() => {
        let stopped = false, timer: ReturnType<typeof setTimeout>;
        async function poll() { try {
            const list = await desktopClient.request<WorkerView[]>('worker.list');
            if (!stopped)
                setWorkers(list);
            const status = await desktopClient.request<NativeStatus>('worker.status').catch(() => null);
            if (!stopped && status) {
                setNative(status);
                if (status.name)
                    setName(status.name);
            }
        }
        catch (e) {
            if (!stopped)
                setError((e as Error).message);
        }
        finally {
            if (!stopped)
                timer = setTimeout(() => void poll(), 2000);
        } }
        void poll();
        void desktopClient.modelSettings<DeviceStatus>({ action: 'status' }).then(s => { if (!stopped)
            setDevice(s); }).catch(() => { });
        return () => { stopped = true; clearTimeout(timer); };
    }, []);
    async function action(method: string, params: unknown = {}) { setBusy(true); setError(''); try {
        const result = await desktopClient.request<NativeStatus>(method, params);
        if (['worker.enroll', 'worker.start', 'worker.stop', 'worker.remove'].includes(method))
            setNative(result);
        await refresh();
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    return <section className="device-panel worker-list">
  <h2>Рабочие устройства</h2><p>На устройстве выполняются до двух заданий. Пауза сохраняет текущий этап перед остановкой. Закрытые устройства не получают новые задания.</p>
  {error ? <p role="alert">{error}</p> : null}
  <label>Название этого устройства<input value={name} disabled={busy || !!native?.workerId} onChange={e => setName(e.target.value)}/></label>
  <div className="row-actions">
   <button disabled={busy || native?.enrolled} onClick={() => void action('worker.enroll', { name })}>{native?.workerId ? 'Повторить регистрацию' : 'Зарегистрировать устройство'}</button>
   <button disabled={busy || !native?.enrolled || native.running} onClick={() => void action('worker.start')}>Запустить</button>
   <button disabled={busy || !native?.running} onClick={() => void action('worker.stop')}>Остановить</button>
   <button disabled={busy || !native?.workerId} onClick={() => void action('worker.remove')}>Отозвать это устройство</button>
  </div>
  <p>{native?.running ? 'Исполнитель запущен' : native?.enrolled ? 'Устройство зарегистрировано; исполнитель остановлен' : 'Регистрация и запуск доступны в нативном приложении.'}</p>
  {native?.error ? <p role="alert">{native.error}</p> : null}
  <table><thead><tr><th>Устройство</th><th>Последний сигнал</th><th>Сохранённый этап</th><th>Действия</th></tr></thead><tbody>
   {workers.map(w => <tr key={w.id}><td>{w.name}{w.revoked ? ' · отозвано' : w.paused ? ' · пауза' : ''}</td><td>{w.lastHeartbeat === null ? 'Ещё не подключалось' : new Date(w.lastHeartbeat).toLocaleString('ru-RU')}</td><td>{w.jobs.length ? w.jobs.map(j => <p key={j.id}><span>{j.stage} · {j.state}</span> {!['completed', 'cancelled'].includes(j.state) ? <button disabled={busy} onClick={() => void action('job.cancel', { siteId: j.siteId })}>Отменить задание</button> : null}</p>) : 'Нет активных заданий'}</td><td><button disabled={busy || w.revoked} onClick={() => void action(w.paused ? 'worker.resume' : 'worker.pause', { id: w.id })}>{w.paused ? 'Продолжить выдачу' : 'Пауза'}</button><button disabled={busy || w.revoked} onClick={() => void action('worker.revoke', { id: w.id })}>Отозвать</button></td></tr>)}
  </tbody></table>
  <p>Генерация сохраняет результаты в общем хранилище. Внешняя публикация пока не подключена.</p>
  <p>После сбоя запрос модели может повториться. Расход запросов с неизвестным ответом сохраняется отдельно и не считается нулевым.</p>
  {device ? <ModelSettings device={device} managed onChanged={setDevice}/> : null}
 </section>;
}
