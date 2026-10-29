import type { PublicationState } from './model.js';
export type { PublicationState } from './model.js';
export interface PublicationDiagnostic {code:'account_configuration'|'quota'|'dns_pending'|'tls_error'|'wrong_version'|'unsafe_destination'|'binding_mismatch'|'ambiguous_mutation'|'provider_unavailable'|'settlement_conflict';action:string;at:number;retryable:boolean;}
export const publicationDiagnosticCaptions:Record<PublicationDiagnostic['code'],string>={account_configuration:'Проверьте доступ и настройки хостинга',quota:'Хостинг временно ограничил запросы',dns_pending:'DNS ещё не готов',tls_error:'Сертификат HTTPS не подтверждён',wrong_version:'Публичный ответ отличается от ожидаемой версии',unsafe_destination:'Небезопасный адрес заблокирован',binding_mismatch:'Неизменяемая привязка публикации не совпадает',ambiguous_mutation:'Результат изменения уточняется; повторная отправка не разрешена',provider_unavailable:'Сервис хостинга недоступен',settlement_conflict:'Установка опубликованной версии требует проверки'};
export function safePublicationDiagnostic(value:unknown):PublicationDiagnostic|null{
    if(!value||typeof value!=='object'||Array.isArray(value))return null;const d=value as Record<string,unknown>;
    if(typeof d.code!=='string'||!Object.hasOwn(publicationDiagnosticCaptions,d.code)||typeof d.action!=='string'||!['project','project_create','domain','domain_attach','verify_domain','dns','upload','create','find','check','promote','alias','https','settle'].includes(d.action)||!Number.isSafeInteger(d.at)||Number(d.at)<0||typeof d.retryable!=='boolean')return null;
    return {code:d.code as PublicationDiagnostic['code'],action:d.action,at:Number(d.at),retryable:d.retryable};
}
export interface PublicationIntent {
    id: string;
    siteId: string;
    revisionId: string;
    manifestHash: string;
    deploymentId: string | null;
    phase: PublicationState;
}
export interface DnsRecord {
    type: 'A' | 'CNAME' | 'TXT';
    name: string;
    value: string;
}
export interface DomainSetup {
    records: DnsRecord[];
    verified: boolean;
}
export interface PublicationView extends PublicationIntent {
    diagnostic?:PublicationDiagnostic|null;
    revisionId: string;
    manifestId: string;
    retryAt: number | null;
    cancelRequested: boolean;
    settlement: 'pending' | 'settled' | 'cancelled' | 'conflict';
    verifiedAt: number | null;
    origin: 'generation' | 'draft' | 'rollback';
}
export interface PublicationReceipt {
    jobId: string;
    requestKey: string;
    siteId: string;
    revisionId: string;
    manifestId: string;
    expectedRevision: number;
    checkpointId: string;
}
